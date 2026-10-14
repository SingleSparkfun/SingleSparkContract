// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {PonsVaultFactory} from "../PonsVaultFactory.sol";
import {PonsGameplayVault} from "../PonsGameplayVault.sol";
import {PonsSwapAdapter} from "../PonsSwapAdapter.sol";
import {IPonsLaunch, IPonsCurve, IPonsHook} from "../IPonsLaunch.sol";
import {GameplayBuybackPlugin} from "../../../../evm/gameplay/GameplayPlugins.sol";
import {GameplayClaim, GameplayPolicy, IGameplayFactory} from "../../../../evm/gameplay/IGameplayProtocol.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";

interface IPonsRevenueForkSource is IPonsLaunch {
    function previewLaunchEconomics(uint256 config, address pair) external view returns (bytes32);
    function launchFee() external view returns (uint256);
    function graduate(address token) external;
    function createGraduatedPool(address token) external returns (uint256);
}

/// Run explicitly on a Robinhood Testnet fork; every deployment and transaction stays in the local EVM.
contract PonsRevenueClaimForkTest is Test {
    uint256 private constant KEY = 0x123456;
    address private constant CALLER = address(0x2000);
    bytes32 private constant BURN = keccak256("buyback-burn@1");

    function testRealGraduatedFeesFundManualClaimAndExecutionReward() public {
        if (block.chainid != 46630) { vm.skip(true); return; }
        IPonsRevenueForkSource source = IPonsRevenueForkSource(0xEc987cEb5F08D6bdE2871E78AB67Af145746BC8c);
        assertEq(address(source).codehash, 0x8610636d8e26ebda6a9fccdd4913d12eb19e0db8463422d137794ac9a7bfd394);
        IPonsHook hook = IPonsHook(source.memeHook());
        assertEq(address(hook).codehash, 0xafc4875f7c3528e18c90ef69f5d90d7021f8e82769f945867414f48c5fc5cab4);
        vm.deal(address(this), 1 ether);
        vm.deal(CALLER, 1 ether);
        PonsVaultFactory factory = new PonsVaultFactory(address(this), vm.addr(KEY), address(0x9999), source);
        GameplayBuybackPlugin plugin = new GameplayBuybackPlugin();
        PonsSwapAdapter adapter = new PonsSwapAdapter(IGameplayFactory(address(factory)), source);
        factory.schedulePlugin(BURN, address(plugin));
        bytes32 operation = factory.scheduleAdapter(address(adapter));
        vm.warp(factory.readyAt(operation));
        factory.executePlugin(BURN, address(plugin));
        factory.executeAdapter(address(adapter));

        IPonsLaunch.TokenParams memory draft;
        draft.name = "Revenue Claim Fork"; draft.symbol = "RCF"; draft.creatorTaxBps = 200;
        draft.expectedEconomics = source.previewLaunchEconomics(0, address(0));
        draft.salt = keccak256("revenue-claim-fork");
        (address token, address curve, address vaultAddress) = factory.launch{value: source.launchFee()}(draft);
        PonsGameplayVault vault = PonsGameplayVault(payable(vaultAddress));
        IPonsLaunch.LaunchedToken memory launch = source.getLaunchedToken(token);
        PoolKey memory pool = PoolKey(Currency.wrap(address(0)), Currency.wrap(token), launch.poolFee, launch.tickSpacing, IHooks(address(hook)));
        GameplayPolicy[] memory policies = new GameplayPolicy[](1);
        policies[0] = GameplayPolicy(BURN, 1, token, address(adapter), 100_000_000_000, abi.encode(pool, uint160(0)), "");
        operation = factory.schedulePolicy(vaultAddress, policies);
        vm.warp(factory.readyAt(operation)); factory.executePolicy(vaultAddress, policies);

        IPonsCurve(curve).buy{value: 40_000_000_000_000}(40_000_000_000_000, 1, address(this));
        if (source.getLaunchedToken(token).phase == 0) source.graduate(token);
        if (source.getLaunchedToken(token).phase == 1) source.createGraduatedPool(token);
        assertEq(source.getLaunchedToken(token).phase, 2);
        vault.collectRevenue();
        uint256 beforeIncome = vault.received();
        uint256 beforeBudget = vault.budget(BURN);
        uint256 beforeClaimBudget = vault.claimBudget();

        PoolSwapTest trader = new PoolSwapTest(IPoolManager(source.poolManager()));
        IERC20(token).approve(address(trader), type(uint256).max);
        trader.swap(pool, SwapParams(false, -int256(IERC20(token).balanceOf(address(this)) / 1000), TickMath.MAX_SQRT_PRICE - 1), PoolSwapTest.TestSettings(false, false), "");
        (bytes32 poolId, uint256 nativePending, uint256 tokenPending, bool needsOperator) = vault.poolRevenue();
        assertGt(nativePending, 0); assertEq(tokenPending, 0); assertFalse(needsOperator);
        uint256 callerBalance = CALLER.balance;
        vm.prank(CALLER); vault.collectRevenue();
        assertGt(vault.received(), beforeIncome);
        assertGt(vault.budget(BURN), beforeBudget); assertGt(vault.claimBudget(), beforeClaimBudget);
        assertEq(CALLER.balance, callerBalance);
        uint256 received = vault.received();
        vault.collectRevenue(); assertEq(vault.received(), received);
        assertEq(hook.pendingFees(poolId, address(0)), 0);
        assertEq(hook.pendingCreatorTax(poolId, address(0)), 0);

        uint256 amount = 100_000_000_000;
        uint256 reward = amount * 50 / 8950;
        GameplayClaim memory claim = GameplayClaim(CALLER, BURN, amount, 1, reward, block.timestamp + 120,
            vault.nonce(), vault.revision(), factory.revision(), keccak256(""));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(KEY, vault.claimDigest(claim));
        bytes memory signature = abi.encodePacked(r, s, v);
        uint256 burned = IERC20(token).balanceOf(address(0xdead));
        uint256 balance = vaultAddress.balance;
        uint256 budget = vault.budget(BURN);
        uint256 claimBudget = vault.claimBudget();
        vm.expectRevert(); vault.claim(claim, "", signature);
        vm.prank(CALLER); vault.claim(claim, "", signature);
        assertGt(IERC20(token).balanceOf(address(0xdead)), burned);
        assertEq(vault.budget(BURN), budget - amount);
        assertEq(vault.claimBudget(), claimBudget - reward);
        assertEq(vaultAddress.balance, balance - amount - reward);
        assertEq(CALLER.balance, callerBalance + reward);
        assertEq(vault.nonce(), claim.nonce + 1);
        vm.expectRevert(); vm.prank(CALLER); vault.claim(claim, "", signature);

        (,,tokenPending,needsOperator) = vault.poolRevenue();
        assertGt(tokenPending, 0); assertTrue(needsOperator);
        address operator = hook.feeSweepOperator();
        vm.expectRevert(abi.encodeWithSelector(PonsGameplayVault.UpstreamFeeSweepRequired.selector, poolId, operator));
        vault.collectRevenue();
        // Impersonation only on the fork verifies the upstream operator boundary without its private key.
        vm.prank(operator); hook.sweepPoolFees(poolId, 1, 0);
        vault.collectRevenue(); assertGt(vault.received(), received);
    }

    receive() external payable {}
}
