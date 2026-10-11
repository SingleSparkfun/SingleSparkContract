// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {GameplayPolicy, IGameplayPlugin, IGameplayVault} from "./IGameplayProtocol.sol";

/// The same reviewed implementation may occupy separate own-token/platform-token budget slots.
contract GameplayBuybackPlugin is IGameplayPlugin {
    function validate(address, address, GameplayPolicy calldata policy) external pure {
        require(policy.rules.length == 0 && policy.maxSpend != 0, "Invalid buyback policy");
    }

    function execute(bytes calldata data) external {
        require(data.length == 0, "Unexpected buyback data");
        IGameplayVault(msg.sender).pluginAcquire();
        IGameplayVault(msg.sender).pluginBurn();
    }
}

contract GameplayDistributionPlugin is IGameplayPlugin {
    function validate(address, address, GameplayPolicy calldata policy) external pure {
        (uint256 amount, uint256 minimumBatch) = abi.decode(policy.rules, (uint256, uint256));
        require(policy.rules.length == 64 && policy.maxSpend != 0 && amount != 0
            && minimumBatch != 0 && minimumBatch <= 200, "Invalid distribution policy");
    }

    function execute(bytes calldata data) external {
        IGameplayVault vault = IGameplayVault(msg.sender);
        if (data.length == 0) {
            vault.pluginAcquire();
            vault.pluginStore();
        } else {
            address[] memory recipients = abi.decode(data, (address[]));
            (uint256 amount, uint256 minimumBatch) = abi.decode(vault.activePolicy().rules, (uint256, uint256));
            require(recipients.length >= minimumBatch && recipients.length <= 200, "Invalid batch size");
            vault.pluginDistribute(recipients, amount);
        }
    }
}
