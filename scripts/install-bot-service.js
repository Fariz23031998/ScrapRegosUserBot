const path = require('path');
const os = require('os');
const { Service } = require('node-windows');

const projectRoot = path.join(__dirname, '..');
const logsDir = path.join(projectRoot, 'logs');
const serviceName = 'ScrapRegosUserBot';
const userInfo = os.userInfo();

const svc = new Service({
  name: serviceName,
  description: 'Regos user lookup Telegram bot',
  script: path.join(projectRoot, 'bot.js'),
  workingDirectory: projectRoot,
  logpath: logsDir,
  grow: 0.25,
  wait: 2,
  maxRestarts: 10,
  abortOnError: false,
  env: [
    {
      name: 'NODE_ENV',
      value: 'production',
    },
  ],
});

if (process.env.SERVICE_PASSWORD) {
  svc.logOnAs.domain = process.env.USERDOMAIN || '.';
  svc.logOnAs.account = userInfo.username;
  svc.logOnAs.password = process.env.SERVICE_PASSWORD;
  console.log(`Service will run as ${svc.logOnAs.domain}\\${svc.logOnAs.account}`);
} else {
  console.log(`Service will run as ${userInfo.username} (installer account).`);
  console.log('To run under your login explicitly, set SERVICE_PASSWORD before install.');
}

svc.on('install', () => {
  console.log(`Service "${serviceName}" installed.`);
  console.log(`Logs: ${logsDir}`);
  svc.start();
});

svc.on('alreadyinstalled', () => {
  console.error(`Service "${serviceName}" is already installed.`);
  console.error('Run: npm run service:uninstall');
  process.exit(1);
});

svc.on('start', () => {
  console.log(`Service "${serviceName}" started.`);
});

svc.on('error', (err) => {
  console.error('Service install error:', err);
  process.exit(1);
});

console.log(`Installing service "${serviceName}"...`);
console.log('Run this script from an elevated (Administrator) terminal.');
svc.install();
