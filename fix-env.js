const fs = require('fs');
const { execSync } = require('child_process');

const content = fs.readFileSync('.env', 'utf-8');
const lines = content.split(/\r?\n/);

for (const line of lines) {
  const match = line.match(/^([A-Z_]+)=(.*)$/);
  if (match) {
    const key = match[1];
    let val = match[2].trim();
    if (val.startsWith('"') && val.endsWith('"')) { val = val.slice(1, -1); }
    else if (val.startsWith("'") && val.endsWith("'")) { val = val.slice(1, -1); }
    
    console.log('Removing ' + key);
    try {
      execSync(`npx vercel env rm ${key} production --scope karthik008-cods-projects -y`, {stdio: 'ignore'});
    } catch(e){}
    
    console.log('Adding ' + key);
    execSync(`npx vercel env add ${key} production --scope karthik008-cods-projects`, {
      input: val,
      stdio: ['pipe', 'inherit', 'inherit']
    });
  }
}
