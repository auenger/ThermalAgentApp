// Repackage the test runner's installed dependencies as offline wheels. No network or package build hooks.
export const reportWheelFixture = String.raw`import sys,importlib.metadata as m,re,pathlib,zipfile,hashlib,base64,csv,io,json
out=pathlib.Path(sys.argv[1]);out.mkdir();result=[];external=len(sys.argv)>2 and sys.argv[2]=='external'
for name in ['reportlab','pypdf','pillow','charset-normalizer']:
 d=m.distribution(name);prefix=next(str(f).split('/')[0] for f in d.files if str(f).endswith('.dist-info/METADATA'))
 wheeltext=d.read_text('WHEEL');tag=next(line[5:] for line in wheeltext.splitlines() if line.startswith('Tag: '))
 filename=name.replace('-','_')+'-'+d.version+'-'+tag+'.whl';files={}
 for f in d.files:
  s=str(f)
  if '..' in pathlib.PurePosixPath(s).parts or s.endswith(('.pyc','.pyo')) or '__pycache__' in s or s.endswith('/RECORD'):continue
  p=d.locate_file(f)
  if p.is_file():files[s]=p.read_bytes()
 if external and name=='reportlab':files['reportlab/_thermal_external_asset_padding.bin']=bytes(33*1024*1024)
 rows=[[k,'sha256='+base64.urlsafe_b64encode(hashlib.sha256(v).digest()).decode().rstrip('='),str(len(v))] for k,v in files.items()]
 rows.append([prefix+'/RECORD','','']);buf=io.StringIO();csv.writer(buf).writerows(rows);files[prefix+'/RECORD']=buf.getvalue().encode()
 with zipfile.ZipFile(out/filename,'w',compression=zipfile.ZIP_DEFLATED) as z:
  for k,v in files.items():z.writestr(k,v,compress_type=zipfile.ZIP_STORED if k.endswith('_thermal_external_asset_padding.bin') else zipfile.ZIP_DEFLATED)
 result.append({'name':name,'version':d.version,'path':'wheels/'+filename,'sha256':hashlib.sha256((out/filename).read_bytes()).hexdigest(),**({'asset':{'sizeBytes':(out/filename).stat().st_size}} if external else {})})
print(json.dumps(result))`

