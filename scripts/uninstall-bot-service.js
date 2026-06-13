const path = require('path');
const { Service } = require('node-windows');

const serviceName = 'ScrapRegosUserBot';

const svc = new Service({
  name: serviceName,
  script: path.join(__dirname, '..', 'bot.js'),
});

svc.on('uninstall', () => {
  console.log(`Service "${serviceName}" uninstalled.`);
});

svc.on('alreadyuninstalled', () => {
  console.log(`Service "${serviceName}" is not installed.`);
});

svc.on('error', (err) => {
  console.error('Service uninstall error:', err);
  process.exit(1);
});

console.log(`Uninstalling service "${serviceName}"...`);
console.log('Run this script from an elevated (Administrator) terminal.');
svc.uninstall();
