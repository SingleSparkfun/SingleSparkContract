// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {GameplayFixture, GameplayTestToken} from "../../../../evm/gameplay/test/GameplayFixture.sol";
import {GameplayVault} from "../../../../evm/gameplay/GameplayVault.sol";
import {GameplayClaim, GameplayPolicy, IGameplayFactory} from "../../../../evm/gameplay/IGameplayProtocol.sol";
import {PonsSwapAdapter} from "../PonsSwapAdapter.sol";
import {IPonsLaunch} from "../IPonsLaunch.sol";
import {PoolManager} from "@uniswap/v4-core/src/PoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolModifyLiquidityTest} from "@uniswap/v4-core/src/test/PoolModifyLiquidityTest.sol";
import {ModifyLiquidityParams, SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";

contract PonsSwapTestCurve {
    address public immutable token;
    address public immutable factory;
    address public constant pairToken = address(0);
    bool public graduated;
    bool public refund;
    constructor(address token_) { token = token_; factory = msg.sender; }
    function setRefund() external { refund = true; }
    function graduate() external { graduated = true; }
    function buy(uint256 amount, uint256 minimum, address recipient) external payable returns (uint256) {
        require(msg.value == amount && amount >= minimum);
        if (refund) { (bool ok,) = msg.sender.call{value: 1}(""); require(ok); }
        GameplayTestToken(token).mint(recipient, amount);
        return amount;
    }
}
contract PonsSwapTestFeeHook {
    IPoolManager private immutable manager;
    constructor(IPoolManager manager_) { manager = manager_; }
    function afterSwap(address, PoolKey calldata key, SwapParams calldata params, BalanceDelta delta, bytes calldata)
        external returns (bytes4, int128)
    {
        require(msg.sender == address(manager) && params.zeroForOne && params.amountSpecified < 0);
        uint256 output = uint256(uint128(delta.amount1()));
        uint256 fee = output / 100 + output / 10;
        manager.take(key.currency1, address(this), fee);
        return (IHooks.afterSwap.selector, int128(uint128(fee)));
    }
}
contract PonsSwapTestSource {
    address public poolManager;
    address public memeHook;
    IPonsLaunch.LaunchedToken private launch;
    constructor(address manager, address token) {
        poolManager = manager; memeHook = address(new GameplayTestToken(18));
        launch.token = token; launch.curve = address(new PonsSwapTestCurve(token));
        launch.poolFee = 0; launch.tickSpacing = 200; launch.exists = true;
    }
    function getLaunchedToken(address) external view returns (IPonsLaunch.LaunchedToken memory) { return launch; }
    function setHook(address value) external { memeHook = value; }
}
contract PonsSwapAdapterTest is GameplayFixture {
    PonsSwapTestSource source;
    PonsSwapAdapter adapter;
    bytes route;
    function setUp() public override {
        super.setUp();
        source = new PonsSwapTestSource(address(new PoolManager(address(this))), address(project));
        adapter = new PonsSwapAdapter(IGameplayFactory(address(factory)), IPonsLaunch(address(source)));
        bytes32 operation = factory.scheduleAdapter(address(adapter)); vm.warp(factory.readyAt(operation));
        factory.executeAdapter(address(adapter));
        route = abi.encode(PoolKey(Currency.wrap(address(0)), Currency.wrap(address(project)), 0, 200, IHooks(source.memeHook())), uint160(0));
    }
    function vault() private returns (GameplayVault v) {
        GameplayPolicy[] memory p = new GameplayPolicy[](1);
        p[0] = GameplayPolicy(BURN, 1, address(project), address(adapter), 1 ether, route, "");
        v = create(address(0), p); fund(v, 1 ether);
    }
    function testCurveBuyAndBurnLeavesNoFundsInAdapter() public {
        GameplayVault v = vault(); GameplayClaim memory c = request(v, BURN, 0.1 ether, "");
        c.minimumOutput = 0.1 ether; execute(v, c, "");
        assertEq(project.balanceOf(address(0xdead)), 0.1 ether);
        assertEq(address(adapter).balance, 0); assertEq(v.accounted(), 0.9 ether);
    }
    function testSlippageAndPartialFillRevertWithoutSpendingBudget() public {
        GameplayVault v = vault(); GameplayClaim memory c = request(v, BURN, 0.1 ether, "");
        c.minimumOutput = 0.2 ether;
        bytes memory signature = sign(v, c);
        vm.expectRevert(); vm.prank(CALLER); v.claim(c, "", signature);
        assertEq(v.nonce(), 0);
        PonsSwapTestCurve(payable(source.getLaunchedToken(address(project)).curve)).setRefund();
        c.minimumOutput = 1;
        signature = sign(v, c);
        vm.expectRevert(); vm.prank(CALLER); v.claim(c, "", signature);
        assertEq(v.budget(BURN), 0.895 ether); assertEq(address(v).balance, 1 ether);
    }
    function testWrongRouteOutsidersAndChangedSourceAreRejected() public {
        vm.expectRevert(); adapter.swap(address(0), address(project), 1, 1, block.timestamp + 1, route);
        vm.expectRevert(); adapter.validate(address(0), address(quote), route);
        source.setHook(address(quote));
        vm.expectRevert(); adapter.validate(address(0), address(project), route);
    }
    function testGraduatedHighTaxPoolAcceptsNetQuoteAndRejectsTheOldGrossQuote() public {
        IPoolManager manager = IPoolManager(source.poolManager());
        PonsSwapTestFeeHook feeHook = new PonsSwapTestFeeHook(manager);
        // V4 afterSwap and afterSwapReturnDelta permission bits, with the same immutable manager.
        address hook = address(0x44); vm.etch(hook, address(feeHook).code); source.setHook(hook);
        PonsSwapTestCurve(source.getLaunchedToken(address(project)).curve).graduate();
        adapter = new PonsSwapAdapter(IGameplayFactory(address(factory)), IPonsLaunch(address(source)));
        bytes32 operation = factory.scheduleAdapter(address(adapter)); vm.warp(factory.readyAt(operation));
        factory.executeAdapter(address(adapter));
        PoolKey memory key = PoolKey(Currency.wrap(address(0)), Currency.wrap(address(project)), 0, 200, IHooks(hook));
        manager.initialize(key, uint160(1 << 96));
        PoolModifyLiquidityTest liquidity = new PoolModifyLiquidityTest(manager);
        project.mint(address(this), 1_000_000 ether); project.approve(address(liquidity), type(uint256).max);
        vm.deal(address(this), 100 ether);
        liquidity.modifyLiquidity{value: 100 ether}(key, ModifyLiquidityParams(-600, 600, 1000 ether, bytes32(0)), "");
        route = abi.encode(key, uint160(0));
        GameplayVault v = vault(); GameplayClaim memory c = request(v, BURN, 0.1 ether, "");
        c.minimumOutput = 0.095 ether;
        bytes memory signature = sign(v, c);
        vm.expectRevert(); vm.prank(CALLER); v.claim(c, "", signature);
        assertEq(v.nonce(), 0); assertEq(v.accounted(), 1 ether);
        c.minimumOutput = 0.08455 ether; execute(v, c, "");
        assertGt(project.balanceOf(address(0xdead)), c.minimumOutput);
        assertEq(v.accounted(), 0.9 ether); assertEq(address(adapter).balance, 0);
    }
}
