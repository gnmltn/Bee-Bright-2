# Bee Bright Smart Contract Gas Report

Generated: 2026-03-18T15:51:56.009Z

## Scope
- Contract: `BeeBrightPayments.sol`
- Optimizer: enabled, 200 runs
- Network: local Ganache in-memory chain

## Gas Matrix

| Function / Action | Scenario | Gas Used | Notes |
| --- | --- | ---: | --- |
| Deployment | Constructor with valid Bee Bright wallet | 180219 | Includes custom errors + immutable wallet initialization |
| pay(bytes32) | First successful payment (0.10 ETH) | 55447 | Forwards ETH and emits PaymentReceived |
| pay(bytes32) | Second successful payment (0.25 ETH) | 38347 | Slightly lower after warm state access |
| totalPayments() | Off-chain read | 0 | View function when called from frontend/backend RPC |
| beeBrightWallet() | Off-chain read | 0 | View function when called from frontend/backend RPC |
| receive() | Direct transfer attempt | Reverts by design | Prevents untracked payments without an enrollment reference |

## Optimization Notes
- `beeBrightWallet` is `immutable`, reducing repeated storage reads.
- Custom errors replace long revert strings to lower deployment and runtime gas.
- `unchecked` increment is used for `totalPayments` because realistic payment volume will not overflow `uint256`.
- Direct transfers are blocked so every on-chain payment keeps a traceable `enrollmentRef` event.

## Defense Talking Point
The contract exposes only one payable business action, `pay(bytes32)`. Gas was measured on deployment and on repeated successful payments, and the design intentionally keeps the state footprint small: one immutable address, one counter, and one event per payment.
