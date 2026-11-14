"""Lossless text container shared with src/notice-text.mjs. Not legal clearance."""
import hashlib,json,re
MAGIC=b'Codecang collected notice texts v1\n'
def safe(n):
 return isinstance(n,str) and len(n)<1024 and not re.search(r'[\\:\x00-\x1f]',n) and not n.startswith('/') and all(x and x not in ('.','..') for x in n.split('/'))
def collect(items):
 if not items or len(items)>10000:raise ValueError('Invalid notice count')
 parts=[];entries=[];groups={};seen=set();offset=0
 for name,value in sorted(items.items()):
  if not safe(name) or name.lower() in seen:raise ValueError('Unsafe notice path')
  seen.add(name.lower());value.decode('utf-8')
  if not value:raise ValueError('Empty notice')
  digest=hashlib.sha256(value).hexdigest()
  if digest in groups:
   start,old=groups[digest]
   if old!=value:raise ValueError('Hash collision')
  else:
   title=('\n\n===== '+name+' =====\n').encode();parts.extend((title,value));offset+=len(title);start=offset;groups[digest]=(start,value);offset+=len(value)
  entries.append(dict(path=name,sha256=digest,offset=start,length=len(value)))
 return MAGIC+json.dumps(entries,ensure_ascii=False,separators=(',',':')).encode()+b'\n\n'+b''.join(parts)
def read(data):
 if len(data)>64*1024*1024 or not data.startswith(MAGIC):raise ValueError('Invalid notice collection')
 end=data.find(b'\n\n',len(MAGIC))
 if end<0 or end>4*1024*1024:raise ValueError('Invalid notice index')
 index=json.loads(data[len(MAGIC):end]);body=data[end+2:];result={}
 if not isinstance(index,list) or not index or len(index)>10000:raise ValueError('Invalid notice index')
 for item in index:
  name=item['path'];start=item['offset'];length=item['length']
  if not safe(name) or name in result or type(start)!=int or type(length)!=int or start<0 or length<=0 or start+length>len(body):raise ValueError('Invalid notice slice')
  value=body[start:start+length]
  if hashlib.sha256(value).hexdigest()!=item['sha256']:raise ValueError('Notice text changed')
  result[name]=value
 if collect(result)!=data:raise ValueError('Noncanonical notice collection')
 return result
