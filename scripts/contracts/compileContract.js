const fs = require('fs');
const path = require('path');
const solc = require('solc');

const CONTRACT_FILENAME = 'BeeBrightPayments.sol';
const CONTRACT_NAME = 'BeeBrightPayments';

function compileBeeBrightPayments() {
  const contractPath = path.resolve(__dirname, '..', '..', 'contracts', CONTRACT_FILENAME);
  const source = fs.readFileSync(contractPath, 'utf8');

  const input = {
    language: 'Solidity',
    sources: {
      [CONTRACT_FILENAME]: {
        content: source,
      },
    },
    settings: {
      optimizer: {
        enabled: true,
        runs: 200,
      },
      outputSelection: {
        '*': {
          '*': ['abi', 'evm.bytecode.object'],
        },
      },
    },
  };

  const output = JSON.parse(solc.compile(JSON.stringify(input)));
  const errors = output.errors || [];
  const fatalErrors = errors.filter((entry) => entry.severity === 'error');

  if (fatalErrors.length > 0) {
    throw new Error(fatalErrors.map((entry) => entry.formattedMessage).join('\n\n'));
  }

  const compiled = output.contracts?.[CONTRACT_FILENAME]?.[CONTRACT_NAME];
  if (!compiled?.evm?.bytecode?.object) {
    throw new Error(`Compiled bytecode for ${CONTRACT_NAME} was not found.`);
  }

  return {
    abi: compiled.abi,
    bytecode: `0x${compiled.evm.bytecode.object}`,
  };
}

module.exports = {
  compileBeeBrightPayments,
};
