// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @notice Optional EVM payout plugin called by one custodial Hook wallet.
/// @dev The Rust ledger calculates exact amounts; this contract makes the payouts atomic.
contract NativeRevenueSplitter {
    address public immutable hookWallet;
    mapping(bytes32 => bool) public executed;
    bool private entered;

    error Unauthorized();
    error InvalidDistribution();
    error AlreadyExecuted();
    error TransferFailed();

    event RevenueDistributed(bytes32 indexed operationId, address indexed recipient, uint256 amount);

    constructor(address wallet) {
        if (wallet == address(0)) revert InvalidDistribution();
        hookWallet = wallet;
    }

    function distribute(bytes32 operationId, address payable[] calldata recipients, uint256[] calldata amounts)
        external payable
    {
        if (msg.sender != hookWallet) revert Unauthorized();
        if (entered || executed[operationId]) revert AlreadyExecuted();
        uint256 count = recipients.length;
        if (operationId == bytes32(0) || count == 0 || count > 10 || count != amounts.length) {
            revert InvalidDistribution();
        }
        uint256 total;
        for (uint256 i; i < count; ++i) {
            if (recipients[i] == address(0) || recipients[i] == address(this) || amounts[i] == 0) {
                revert InvalidDistribution();
            }
            total += amounts[i];
        }
        if (total != msg.value) revert InvalidDistribution();
        entered = true;
        executed[operationId] = true;
        for (uint256 i; i < count; ++i) {
            (bool ok,) = recipients[i].call{value: amounts[i]}("");
            if (!ok) revert TransferFailed();
            emit RevenueDistributed(operationId, recipients[i], amounts[i]);
        }
        entered = false;
    }
}
