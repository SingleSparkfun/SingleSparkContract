// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {Test} from "forge-std/Test.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {HookMiner} from "@uniswap/v4-periphery/src/utils/HookMiner.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IPositionManager} from "@uniswap/v4-periphery/src/interfaces/IPositionManager.sol";
import {FeeSplitter} from "launcher/src/periphery/FeeSplitter.sol";
import {FeeSplit} from "launcher/src/interfaces/IFeeSplitter.sol";
import {ArcLaunchV2} from "../src/ArcLaunchV2.sol";
import {ArcLaunchStrategy} from "../src/ArcLaunchStrategy.sol";
import {IFeeSplitter} from "launcher/src/interfaces/IFeeSplitter.sol";
import {ChainProfiles} from "./ChainProfiles.sol";

/// @notice Shared deployment for V2 tests. It declares no tests, so inheriting it re-runs nothing.
abstract contract ArcLaunchV2Fixture is Test {
    receive() external payable {}
    ArcLaunchV2 launch;
    ArcLaunchStrategy strategy;
    IPositionManager positionManager; // Lets a test build a second bare factory with no platform token.
    address jet;
    address project;
    address keeper = address(0xbabe);
    address community;
    address treasury = address(0xf001);
    ChainProfiles.Profile profile;

    /// @dev Arc: every pre-existing test runs against exactly the numbers that used to be constants.
    function _deploy(address operations_) internal {
        vm.chainId(5042002); // ArcOpeningProbe is testnet-only; the factory itself no longer checks the chain
        _deployWith(operations_, ChainProfiles.arc());
    }

    /// @dev A factory for `profile` with no strategy or platform token yet.
    function _newFactory(IPositionManager pm, address keeper_, address operations_) internal returns (ArcLaunchV2) {
        return new ArcLaunchV2(pm, keeper_, operations_, profile.minBuyback, profile.gas);
    }

    function _launchProject(string memory name, string memory symbol, string memory uri, uint24 buyFee, uint24 sellFee)
        internal returns (address)
    {
        return launch.launch(name, symbol, uri, buyFee, sellFee, launch.createProjectTreasury());
    }

    /// @dev Mines the hook-flag salt for these exact constructor arguments and deploys the strategy.
    function _newStrategy(address launcher, IPositionManager pm, IFeeSplitter splitter, uint256 cost, int24 floor)
        internal
        returns (ArcLaunchStrategy)
    {
        (, bytes32 salt) = HookMiner.find(
            address(this),
            Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_ADD_LIQUIDITY_FLAG | Hooks.BEFORE_SWAP_FLAG
                | Hooks.AFTER_SWAP_FLAG | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG
                | Hooks.BEFORE_DONATE_FLAG,
            type(ArcLaunchStrategy).creationCode,
            abi.encode(launcher, pm, splitter, cost, floor)
        );
        return new ArcLaunchStrategy{salt: salt}(launcher, pm, splitter, cost, floor);
    }

    function _deployWith(address operations_, ChainProfiles.Profile memory profile_) internal {
        profile = profile_;
        vm.warp(1000);
        vm.warp(1000);
        vm.deal(address(this), 100_000e18);
        vm.deal(keeper, 5e18);
        IPoolManager pool = IPoolManager(deployCode("PoolManager.sol:PoolManager", abi.encode(address(this))));
        IPositionManager pm = IPositionManager(
            deployCode(
                "PositionManager.sol:PositionManager", abi.encode(pool, address(0), 100_000, address(0), address(0))
            )
        );
        positionManager = pm;
        launch = _newFactory(pm, keeper, operations_);
        FeeSplit[] memory splits = new FeeSplit[](1);
        splits[0] = FeeSplit(address(launch), 10_000, 10_000, true);
        FeeSplitter splitter = FeeSplitter(payable(deployCode("FeeSplitter.sol:FeeSplitter", abi.encode(pm, splits))));
        strategy = _newStrategy(address(launch), pm, splitter, profile_.halfSupplyCost, profile_.minLaunchTick);
        launch.configure(strategy);
        jet = launch.launch("Jet", "JET", "", 30_000, 30_000, address(0));
        launch.setProjectTeam(treasury);
        community = launch.createProjectTreasury();
        project = launch.launch("Project", "PJT", "", 10_000, 50_000, community);
        vm.warp(block.timestamp + 3); // Ordinary economics are measured after opening protection.
    }
}
