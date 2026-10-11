// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

library GameplayAsset {
    using SafeERC20 for IERC20;
    error TransferMismatch();

    function balance(address asset, address account) internal view returns (uint256) {
        return asset == address(0) ? account.balance : IERC20(asset).balanceOf(account);
    }

    /// Exact delivery is required for payouts; restricted/taxed transfers revert atomically.
    function send(address asset, address recipient, uint256 amount) internal {
        uint256 beforeSender = balance(asset, address(this));
        uint256 beforeRecipient = balance(asset, recipient);
        if (asset == address(0)) {
            (bool ok,) = recipient.call{value: amount}("");
            if (!ok) revert TransferMismatch();
        } else IERC20(asset).safeTransfer(recipient, amount);
        if (balance(asset, address(this)) + amount != beforeSender
            || (asset != address(0) && balance(asset, recipient) != beforeRecipient + amount)) revert TransferMismatch();
    }
}
