// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// Box sales stay separate from project revenue and NFT staking rewards.
contract PlatformNftSalesVault {
    uint256 public constant DELAY = 48 hours;
    address public immutable owner;
    uint256 public totalReceived;
    address public payoutRecipient;
    uint256 public payoutAmount;
    uint256 public payoutAfter;
    error Invalid();
    event Income(uint256 amount);
    event PayoutScheduled(address recipient, uint256 amount, uint256 readyAt);
    event PayoutCancelled();
    event PayoutExecuted(address recipient, uint256 amount);

    constructor(address owner_) { if (block.chainid != 46630 || owner_ == address(0)) revert Invalid(); owner = owner_; }
    receive() external payable { totalReceived += msg.value; emit Income(msg.value); }
    function schedulePayout(address recipient, uint256 amount) external {
        if (msg.sender != owner || recipient == address(0) || recipient == address(this) || amount == 0 || amount > address(this).balance) revert Invalid();
        payoutRecipient = recipient; payoutAmount = amount; payoutAfter = block.timestamp + DELAY;
        emit PayoutScheduled(recipient, amount, payoutAfter);
    }
    function cancelPayout() external {
        if (msg.sender != owner) revert Invalid();
        payoutAfter = 0; payoutAmount = 0; payoutRecipient = address(0); emit PayoutCancelled();
    }
    function executePayout() external {
        if (payoutAfter == 0 || block.timestamp < payoutAfter) revert Invalid();
        address recipient = payoutRecipient; uint256 amount = payoutAmount;
        payoutAfter = 0; payoutAmount = 0; payoutRecipient = address(0);
        (bool ok,) = payable(recipient).call{value: amount}(""); if (!ok) revert Invalid();
        emit PayoutExecuted(recipient, amount);
    }
}
