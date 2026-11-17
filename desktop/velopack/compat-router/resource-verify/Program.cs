using System.Buffers.Binary;
using System.Reflection.Metadata;
using System.Reflection.PortableExecutable;
using System.Security.Cryptography;

try
{
    if (args.Length < 3 || args.Length % 2 != 1)
        throw new ArgumentException("Usage: ResourceVerify EXE RESOURCE SHA256 [RESOURCE SHA256 ...]");
    var expected = new Dictionary<string, byte[]>(StringComparer.Ordinal);
    for (int i = 1; i < args.Length; i += 2)
    {
        if (string.IsNullOrWhiteSpace(args[i]) || args[i + 1].Length != 64)
            throw new ArgumentException("A resource name and 64 hex SHA256 characters are required");
        if (!expected.TryAdd(args[i], Convert.FromHexString(args[i + 1])))
            throw new ArgumentException("Duplicate expected resource: " + args[i]);
    }
    int count = expected.Count;
    using var input = File.OpenRead(args[0]);
    using var pe = new PEReader(input, PEStreamOptions.LeaveOpen);
    var headers = pe.PEHeaders;
    var directory = headers.CorHeader?.ResourcesDirectory ?? throw new BadImageFormatException("No CLR resource directory");
    if (!pe.HasMetadata || directory.Size < 4 || directory.RelativeVirtualAddress <= 0 ||
        !headers.TryGetDirectoryOffset(directory, out int offset) || offset < 0 ||
        (long)offset + directory.Size > input.Length ||
        !headers.SectionHeaders.Any(s => directory.RelativeVirtualAddress >= s.VirtualAddress &&
            (long)directory.RelativeVirtualAddress - s.VirtualAddress + directory.Size <= s.SizeOfRawData))
        throw new BadImageFormatException("Resource directory is outside the PE file data");
    var metadata = pe.GetMetadataReader();
    var seen = new HashSet<string>(StringComparer.Ordinal);
    var buffer = new byte[65536];
    Span<byte> prefix = stackalloc byte[4];
    foreach (var handle in metadata.ManifestResources)
    {
        var resource = metadata.GetManifestResource(handle);
        string name = metadata.GetString(resource.Name);
        if (!seen.Add(name)) throw new BadImageFormatException("Duplicate manifest resource: " + name);
        if (!resource.Implementation.IsNil) throw new BadImageFormatException("Linked resource rejected: " + name);
        if (resource.Offset < 0 || resource.Offset > directory.Size - 4L)
            throw new BadImageFormatException("Resource offset outside directory: " + name);
        input.Position = offset + resource.Offset;
        input.ReadExactly(prefix);
        uint length = BinaryPrimitives.ReadUInt32LittleEndian(prefix);
        if (length > directory.Size - resource.Offset - 4L)
            throw new BadImageFormatException("Resource length outside directory: " + name);
        if (!expected.Remove(name, out var hash)) continue;
        using var sha = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        for (long remaining = length; remaining > 0;)
        {
            int read = (int)Math.Min(remaining, buffer.Length);
            input.ReadExactly(buffer.AsSpan(0, read));
            sha.AppendData(buffer, 0, read);
            remaining -= read;
        }
        if (!CryptographicOperations.FixedTimeEquals(sha.GetHashAndReset(), hash))
            throw new InvalidDataException("Resource SHA256 mismatch: " + name);
    }
    if (expected.Count != 0) throw new InvalidDataException("Missing resources: " + string.Join(", ", expected.Keys));
    Console.WriteLine($"Verified {count} embedded resource hashes without loading the target assembly.");
    return 0;
}
catch (Exception error) { Console.Error.WriteLine(error.Message); return 1; }
