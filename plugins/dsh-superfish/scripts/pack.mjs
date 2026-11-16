import {spawnSync} from 'node:child_process';
import {mkdirSync,writeFileSync,readFileSync,existsSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..'),out=resolve(process.argv[2]??resolve(root,'../..'));
mkdirSync(out,{recursive:true});
const legacyNode='/Users/kaisleung/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node';
const legacyPnpm='/Users/kaisleung/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/pnpm/bin/pnpm.mjs';
const useLegacy=existsSync(legacyNode)&&existsSync(legacyPnpm);
const cmd=useLegacy?legacyNode:'pnpm';
const args=useLegacy?[legacyPnpm,'pack','--pack-destination',out]:['pack','--pack-destination',out];
const r=spawnSync(cmd,args,{cwd:root,encoding:'utf8'});
const pkg=JSON.parse(readFileSync(root+'/package.json','utf8')),tgz=out+'/local-dsh-superfish-'+pkg.version+'.tgz';
const receipt={command:[cmd,...args],exitCode:r.status,stdout:r.stdout,stderr:r.stderr};
if(r.status===0){receipt.path=tgz;receipt.sha256=createHash('sha256').update(readFileSync(tgz)).digest('hex');const list=spawnSync('/usr/bin/tar',['-tzf',tgz],{encoding:'utf8'});receipt.tarExitCode=list.status;receipt.entries=list.stdout.trim().split('\n');if(list.status!==0)throw Error(list.stderr);for(const p of ['lib/index.js','lib/preset.js','lib/client.js','locale/zh.json','locale/en.json','icon.png','icon.svg','cordis.patch.yml','skills/dsh-genui/SKILL.md','skills/dsh-quick-actions/SKILL.md','skills/skills-creator/SKILL.md'])if(!receipt.entries.includes('package/'+p))throw Error('缺打包产物 '+p);}
const receiptDir=resolve(root,'../../.superagent-product-lab/b04-deployment');
mkdirSync(receiptDir,{recursive:true});
writeFileSync(receiptDir+'/pack-receipt.json',JSON.stringify(receipt,null,2)+'\n');console.log(JSON.stringify(receipt));process.exitCode=r.status??1;
