const test = require('node:test');
const assert = require('node:assert/strict');
const ganache = require('ganache');
const { ethers } = require('ethers');

const { compileBeeBrightPayments } = require('../../scripts/contracts/compileContract');

async function deployFixture() {
  const eip1193Provider = ganache.provider({
    logging: { quiet: true },
    wallet: { totalAccounts: 4 },
  });

  const provider = new ethers.BrowserProvider(eip1193Provider);
  const deployer = await provider.getSigner(0);
  const beeBrightWallet = await provider.getSigner(1);
  const payer = await provider.getSigner(2);
  const secondPayer = await provider.getSigner(3);

  const { abi, bytecode } = compileBeeBrightPayments();
  const factory = new ethers.ContractFactory(abi, bytecode, deployer);
  const contract = await factory.deploy(await beeBrightWallet.getAddress());
  await contract.waitForDeployment();

  return {
    provider,
    deployer,
    beeBrightWallet,
    payer,
    secondPayer,
    contract,
    abi,
    bytecode,
  };
}

test('constructor rejects a zero beneficiary wallet', async () => {
  const eip1193Provider = ganache.provider({
    logging: { quiet: true },
    wallet: { totalAccounts: 2 },
  });
  const provider = new ethers.BrowserProvider(eip1193Provider);
  const deployer = await provider.getSigner(0);
  const { abi, bytecode } = compileBeeBrightPayments();
  const factory = new ethers.ContractFactory(abi, bytecode, deployer);

  await assert.rejects(
    async () => {
      await factory.deploy(ethers.ZeroAddress);
    },
    /revert|InvalidWallet/i
  );
});

test('pay forwards ETH, increments totalPayments, and emits the enrollment reference', async () => {
  const { contract, beeBrightWallet, payer } = await deployFixture();
  const enrollmentRef = ethers.id('enrollment-001');
  const amount = ethers.parseEther('0.25');

  const tx = await contract.connect(payer).pay(enrollmentRef, { value: amount });
  const receipt = await tx.wait();

  assert.equal(await contract.totalPayments(), 1n);
  assert.equal(await contract.runner.provider.getBalance(await contract.getAddress()), 0n);
  assert.equal(await contract.beeBrightWallet(), await beeBrightWallet.getAddress());

  const parsedLogs = receipt.logs
    .map((log) => {
      try {
        return contract.interface.parseLog(log);
      } catch (error) {
        return null;
      }
    })
    .filter(Boolean);

  const paymentEvent = parsedLogs.find((log) => log.name === 'PaymentReceived');
  assert.ok(paymentEvent, 'expected PaymentReceived event');
  assert.equal(paymentEvent.args.payer, await payer.getAddress());
  assert.equal(paymentEvent.args.amount, amount);
  assert.equal(paymentEvent.args.enrollmentRef, enrollmentRef);
});

test('pay rejects zero-value transactions', async () => {
  const { contract, payer } = await deployFixture();

  await assert.rejects(
    async () => {
      await contract.connect(payer).pay(ethers.id('enrollment-002'), { value: 0n });
    },
    /revert|ZeroPayment/i
  );
});

test('pay rejects an empty enrollment reference', async () => {
  const { contract, payer } = await deployFixture();

  await assert.rejects(
    async () => {
      await contract.connect(payer).pay(ethers.ZeroHash, { value: ethers.parseEther('0.05') });
    },
    /revert|InvalidEnrollmentReference/i
  );
});

test('receive() rejects direct wallet transfers that do not include an enrollment reference', async () => {
  const { contract, payer } = await deployFixture();

  await assert.rejects(
    async () => {
      await payer.sendTransaction({
        to: await contract.getAddress(),
        value: ethers.parseEther('0.01'),
      });
    },
    /revert|DirectTransferNotAllowed/i
  );
});

test('multiple successful payments accumulate in totalPayments', async () => {
  const { contract, payer, secondPayer } = await deployFixture();

  await (await contract.connect(payer).pay(ethers.id('enrollment-003'), { value: ethers.parseEther('0.1') })).wait();
  await (await contract.connect(secondPayer).pay(ethers.id('enrollment-004'), { value: ethers.parseEther('0.2') })).wait();

  assert.equal(await contract.totalPayments(), 2n);
});
