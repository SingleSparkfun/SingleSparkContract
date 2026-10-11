// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

interface IRevenuePluginVault {
    function pluginSwap() external returns (uint256);
    function pluginBurn(uint256 amount) external;
    function pluginInventory(uint256 amount) external;
    function pluginDistribute(address[] calldata recipients) external;
}

interface IRevenuePlugin {
    function kind() external pure returns (uint8);
    function execute(bool payout, address[] calldata recipients) external;
}

/// Gameplay is separate from custody: callbacks can consume only the Vault's current authorized task.
contract BuybackBurnPlugin is IRevenuePlugin {
    function kind() external pure returns (uint8) { return 0; }
    function execute(bool payout, address[] calldata recipients) external {
        require(!payout && recipients.length == 0);
        IRevenuePluginVault vault = IRevenuePluginVault(msg.sender);
        vault.pluginBurn(vault.pluginSwap());
    }
}

contract PlatformBuybackPlugin is IRevenuePlugin {
    function kind() external pure returns (uint8) { return 1; }
    function execute(bool payout, address[] calldata recipients) external {
        require(!payout && recipients.length == 0);
        IRevenuePluginVault vault = IRevenuePluginVault(msg.sender);
        vault.pluginBurn(vault.pluginSwap());
    }
}

contract TokenDistributionPlugin is IRevenuePlugin {
    function kind() external pure returns (uint8) { return 2; }
    function execute(bool payout, address[] calldata recipients) external {
        IRevenuePluginVault vault = IRevenuePluginVault(msg.sender);
        if (payout) vault.pluginDistribute(recipients);
        else {
            require(recipients.length == 0);
            vault.pluginInventory(vault.pluginSwap());
        }
    }
}
