import {spawnSync} from 'node:child_process';import {readFileSync,openSync,closeSync} from 'node:fs';
const repo='/Users/yingbowu/.codex/worktrees/1ae9/acanvas',baseline='/private/tmp/acanvas-review-baseline-6LXSkd',runtime=repo+'/.runtime/node_modules/node/bin/node',lab=readFileSync('/private/tmp/acanvas-smoothness-shared-ready-root.txt','utf8');
for(const [label,cwd]of [['baseline',baseline],['candidate',repo]]){
 const fd=openSync('/private/tmp/acanvas-smoothness-shared-ready-'+label+'.log','w');
 const result=spawnSync(runtime,[cwd+'/node_modules/@playwright/test/cli.js','test','--config',lab+'/tests/frontend.config.ts','frontend.spec.ts','--grep','shared annotation bubbles and static queue previews preserve snapshot references$','--timeout','45000'],{cwd,env:{...process.env,ACANVAS_TEST_OUT_DIR:cwd+'/dist',ACANVAS_TEST_WEB_ROOT:cwd+'/dist/web'},stdio:['ignore',fd,fd]});closeSync(fd);console.log(JSON.stringify({label,exitCode:result.status}));
}
