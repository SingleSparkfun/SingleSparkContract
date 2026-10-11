// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// Each caller spends only its own allowance. Native launch tokens retain their original contracts.
contract NativeRevenueDistributor is ReentrancyGuard {
    using SafeERC20 for IERC20;
    mapping(address wallet => mapping(address token => uint256)) public totalPaid;
    event Paid(address indexed wallet, address indexed token, address indexed recipient, uint256 amount);
    error InvalidBatch();

    function distribute(address token, uint256 expectedTotalPaid, address[] calldata recipients) external nonReentrant {
        if (recipients.length < 100 || recipients.length > 200 || totalPaid[msg.sender][token] != expectedTotalPaid) revert InvalidBatch();
        totalPaid[msg.sender][token] += recipients.length;
        address previous;
        for (uint256 i; i < recipients.length; ++i) {
            address recipient = recipients[i];
            if (recipient <= previous || recipient == msg.sender || recipient == token || recipient == address(this)) revert InvalidBatch();
            previous = recipient;
            IERC20(token).safeTransferFrom(msg.sender, recipient, 10 ether);
            emit Paid(msg.sender, token, recipient, 10 ether);
        }
    }
}
