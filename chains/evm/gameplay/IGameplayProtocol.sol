// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice address(0) denotes native currency. Amounts always use the asset's base units.
struct GameplayPolicy {
    bytes32 id;
    uint32 weight;
    address targetAsset;
    address adapter;
    uint256 maxSpend;
    bytes route;
    bytes rules;
}

struct GameplayClaim {
    address caller;
    bytes32 pluginId;
    uint256 amount;
    uint256 minimumOutput;
    uint256 reward;
    uint256 deadline;
    uint256 nonce;
    uint256 policyRevision;
    uint256 registryRevision;
    bytes32 dataHash;
}

interface IGameplayFactory {
    function createVault(address projectToken, address asset, GameplayPolicy[] calldata selected) external returns (address);
    function predictVault(address owner, address projectToken) external view returns (address);
    function vaultOf(address owner, address projectToken) external view returns (address);
    function authorizer() external view returns (address);
    function treasury() external view returns (address);
    function paused() external view returns (bool);
    function revision() external view returns (uint256);
    function isVault(address vault) external view returns (bool);
    function plugin(bytes32 id) external view returns (address implementation);
    function checkAdapter(address adapter) external view;
}

interface IGameplayPlugin {
    function validate(address projectToken, address asset, GameplayPolicy calldata policy) external view;
    function execute(bytes calldata data) external;
}

interface IGameplaySwapAdapter {
    function validate(address assetIn, address assetOut, bytes calldata route) external view;
    function swap(address assetIn, address assetOut, uint256 amount, uint256 minimumOutput,
        uint256 deadline, bytes calldata route) external payable returns (uint256 output);
}

interface IGameplayVault {
    function deposit(uint256 amount) external payable returns (uint256 credited);
    function sync() external;
    function claim(GameplayClaim calldata request, bytes calldata data, bytes calldata signature) external;
    function claimDigest(GameplayClaim calldata request) external view returns (bytes32);
    function owner() external view returns (address);
    function asset() external view returns (address);
    function projectToken() external view returns (address);
    function nonce() external view returns (uint256);
    function revision() external view returns (uint256);
    function budget(bytes32 id) external view returns (uint256);
    function inventory(bytes32 id) external view returns (uint256);
    function paid(address recipient) external view returns (bool);
    function policy(bytes32 id) external view returns (GameplayPolicy memory);
    function activePolicy() external view returns (GameplayPolicy memory);
    function pluginAcquire() external returns (uint256 output);
    function pluginBurn() external;
    function pluginStore() external;
    function pluginDistribute(address[] calldata recipients, uint256 amountPerRecipient) external;
}
