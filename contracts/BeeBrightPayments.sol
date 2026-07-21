// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

/**
 * Bee Bright Payment Contract
 * Receives ETH payments and forwards to Bee Bright wallet.
 * All payment records are stored on the blockchain.
 */
contract BeeBrightPayments {
    error InvalidWallet();
    error ZeroPayment();
    error InvalidEnrollmentReference();
    error TransferFailed();
    error DirectTransferNotAllowed();

    address payable public immutable beeBrightWallet;
    uint256 public totalPayments;

    event PaymentReceived(
        address indexed payer,
        uint256 amount,
        bytes32 indexed enrollmentRef,
        uint256 timestamp
    );

    constructor(address payable _beeBrightWallet) {
        if (_beeBrightWallet == address(0)) revert InvalidWallet();
        beeBrightWallet = _beeBrightWallet;
    }

    /// @notice Pay for an enrollment. Sends ETH to Bee Bright wallet.
    /// @param enrollmentRef Unique reference (hash of enrollment ID) for linking payment to enrollment
    function pay(bytes32 enrollmentRef) external payable {
        if (msg.value == 0) revert ZeroPayment();
        if (enrollmentRef == bytes32(0)) revert InvalidEnrollmentReference();

        (bool sent, ) = beeBrightWallet.call{value: msg.value}("");
        if (!sent) revert TransferFailed();

        unchecked {
            totalPayments += 1;
        }

        emit PaymentReceived(
            msg.sender,
            msg.value,
            enrollmentRef,
            block.timestamp
        );
    }

    /// @notice Receive ETH directly (fallback)
    receive() external payable {
        revert DirectTransferNotAllowed();
    }
}
