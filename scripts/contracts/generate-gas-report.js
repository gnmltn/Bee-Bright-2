const fs = require('fs');
const path = require('path');
const ganache = require('ganache');
const { ethers } = require('ethers');

const { compileBeeBrightPayments } = require('./compileContract');

async function main() {
  const eip1193Provider = ganache.provider({
    logging: { quiet: true },
    wallet: { totalAccounts: 3 },
  });

  const provider = new ethers.BrowserProvider(eip1193Provider);
  const deployer = await provider.getSigner(0);
  const beeBrightWallet = await provider.getSigner(1);
  const payer = await provider.getSigner(2);

  const { abi, bytecode } = compileBeeBrightPayments();
  const factory = new ethers.ContractFactory(abi, bytecode, deployer);
  const contract = await factory.deploy(await beeBrightWallet.getAddress());
  const deploymentReceipt = await contract.deploymentTransaction().wait();

  const firstPayment = await contract.connect(payer).pay(ethers.id('gas-report-first-payment'), {
    value: ethers.parseEther('0.10'),
  });
  const firstPaymentReceipt = await firstPayment.wait();

  const secondPayment = await contract.connect(payer).pay(ethers.id('gas-report-second-payment'), {
    value: ethers.parseEther('0.25'),
  });
  const secondPaymentReceipt = await secondPayment.wait();

  const reportPath = path.resolve(__dirname, '..', '..', 'docs', 'GAS_REPORT.md');
  const markdown = [
    '# Bee Bright Smart Contract Gas Report',
    '',
    `Generated: ${new Date().toISOString()}`,
    '',
    '## Scope',
    '- Contract: `BeeBrightPayments.sol`',
    '- Optimizer: enabled, 200 runs',
    '- Network: local Ganache in-memory chain',
    '',
    '## Gas Matrix',
    '',
    '| Function / Action | Scenario | Gas Used | Notes |',
    '| --- | --- | ---: | --- |',
    `| Deployment | Constructor with valid Bee Bright wallet | ${deploymentReceipt.gasUsed.toString()} | Includes custom errors + immutable wallet initialization |`,
    `| pay(bytes32) | First successful payment (0.10 ETH) | ${firstPaymentReceipt.gasUsed.toString()} | Forwards ETH and emits PaymentReceived |`,
    `| pay(bytes32) | Second successful payment (0.25 ETH) | ${secondPaymentReceipt.gasUsed.toString()} | Slightly lower after warm state access |`,
    '| totalPayments() | Off-chain read | 0 | View function when called from frontend/backend RPC |',
    '| beeBrightWallet() | Off-chain read | 0 | View function when called from frontend/backend RPC |',
    '| receive() | Direct transfer attempt | Reverts by design | Prevents untracked payments without an enrollment reference |',
    '',
    '## Optimization Notes',
    '- `beeBrightWallet` is `immutable`, reducing repeated storage reads.',
    '- Custom errors replace long revert strings to lower deployment and runtime gas.',
    '- `unchecked` increment is used for `totalPayments` because realistic payment volume will not overflow `uint256`.',
    '- Direct transfers are blocked so every on-chain payment keeps a traceable `enrollmentRef` event.',
    '',
    '## Defense Talking Point',
    'The contract exposes only one payable business action, `pay(bytes32)`. Gas was measured on deployment and on repeated successful payments, and the design intentionally keeps the state footprint small: one immutable address, one counter, and one event per payment.',
    '',
  ].join('\n');

  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, markdown);
  process.stdout.write(`${markdown}\n`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
