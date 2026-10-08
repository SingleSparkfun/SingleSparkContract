// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IExecutorFactory {
    function keeper() external view returns (address);
    function KEEPER_GAS_TRIGGER() external view returns (uint256);
    function terms(address token) external view returns (uint24 fee, address community, address rewards);
}

interface IExecutorRewards {
    function token() external view returns (address);
}

/// @notice The factory's immutable `keeper`. It forwards calls from a replaceable operator wallet, so a lost or
///         leaked keeper key can be rotated without redeploying the factory, its tokens or their rewards contracts.
/// @dev No upgrade path. The owner can only change the operator; it cannot move funds.
contract ArcKeeperExecutor is ReentrancyGuard {
    uint256 public constant KEEPER_EXECUTOR_VERSION = 1;
    /// @dev Same value as the factory's KEEPER_GAS_TRIGGER (2e18 on Arc); `configure` refuses any other factory.
    ///      The operator is topped up to this balance.
    uint256 public immutable OPERATOR_GAS_TARGET;

    /// @dev Must be the account that later calls `configure`; deploying through a shared CREATE2 factory would
    ///      make that factory the administrator and leave the executor unconfigurable forever.
    address public immutable administrator;
    address public owner;
    address public pendingOwner;
    address public operator;
    IExecutorFactory public factory;

    event Configured(address indexed factory);
    event OperatorChanged(address indexed previous, address indexed next);
    event OwnershipTransferStarted(address indexed owner, address indexed pendingOwner);
    event OwnershipTransferred(address indexed previous, address indexed next);
    event Executed(address indexed target, bytes4 indexed selector);

    error Unauthorized();
    error InvalidConfiguration();
    error TargetNotAllowed();
    error InvalidCall();

    constructor(address owner_, address operator_, uint256 operatorGasTarget_) {
        if (owner_ == address(0) || operatorGasTarget_ == 0) revert InvalidConfiguration();
        OPERATOR_GAS_TARGET = operatorGasTarget_;
        administrator = msg.sender;
        owner = owner_;
        operator = operator_;
        emit OwnershipTransferred(address(0), owner_);
        emit OperatorChanged(address(0), operator_);
    }

    /// @dev The factory tops the keeper up with only 30,000 gas. Forward from here only when it is certainly
    ///      affordable: a transfer to an account that may not exist yet costs 25,000 gas more and would make the
    ///      whole top-up fail. Anything held is forwarded by the next execute or by flush, with a normal gas limit.
    receive() external payable {
        if (gasleft() >= 20_000 && operator != address(0) && operator.balance != 0) _forward();
    }

    /// @notice One-shot binding; the deployer keeps no authority afterwards.
    /// @dev The factory cannot already be the operator: `setOperator` can only refuse it once bound. Its keeper
    ///      gas trigger must equal this executor's target, or the two would disagree about when gas is owed.
    function configure(address factory_) external {
        if (msg.sender != administrator || address(factory) != address(0)) revert Unauthorized();
        if (
            factory_.code.length == 0 || IExecutorFactory(factory_).keeper() != address(this) || operator == factory_
                || IExecutorFactory(factory_).KEEPER_GAS_TRIGGER() != OPERATOR_GAS_TARGET
        ) {
            revert InvalidConfiguration();
        }
        factory = IExecutorFactory(factory_);
        emit Configured(factory_);
    }

    /// @notice The zero address pauses every keeper action; funds stay in the factory.
    /// @dev Neither this contract nor the factory may operate it. As the operator, this contract
    ///      would make `_forward` call itself on every execute and `flush` recurse until it ran out
    ///      of gas, and `execute` would be impossible. The factory would receive the reserve as a
    ///      plain transfer and could then drive its own keeper-only functions through `execute`.
    function setOperator(address next) external {
        if (msg.sender != owner) revert Unauthorized();
        if (next == address(this) || (next != address(0) && next == address(factory))) {
            revert InvalidConfiguration();
        }
        emit OperatorChanged(operator, next);
        operator = next;
    }

    function transferOwnership(address next) external {
        if (msg.sender != owner) revert Unauthorized();
        pendingOwner = next;
        emit OwnershipTransferStarted(owner, next);
    }

    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert Unauthorized();
        emit OwnershipTransferred(owner, msg.sender);
        owner = msg.sender;
        pendingOwner = address(0);
    }

    /// @notice The bound factory, or a rewards contract that the factory itself registered for one of its tokens.
    /// @dev The registry check cannot be forged: `terms(token).rewards` only ever holds the contract the factory created.
    function isAllowedTarget(address target) public view returns (bool) {
        // Before `configure` nothing is allowed; without this guard the registry lookup below would call address(0).
        if (address(factory) == address(0)) return false;
        if (target == address(factory)) return true;
        if (target.code.length == 0) return false;
        try IExecutorRewards(target).token() returns (address token_) {
            (,, address rewards) = factory.terms(token_);
            return rewards == target;
        } catch {
            return false;
        }
    }

    /// @notice Forwards one keeper call. No value is ever attached; failures bubble up unchanged because the
    ///         off-chain keeper reads the target's error selectors.
    function execute(address target, bytes calldata data) external nonReentrant returns (bytes memory result) {
        if (msg.sender != operator) revert Unauthorized();
        if (data.length < 4) revert InvalidCall();
        if (!isAllowedTarget(target)) revert TargetNotAllowed();
        bool success;
        (success, result) = target.call(data);
        if (!success) {
            assembly {
                revert(add(result, 32), mload(result))
            }
        }
        emit Executed(target, bytes4(data[:4]));
        _forward();
    }

    /// @notice Anyone may sponsor moving held gas to an operator that cannot afford its first transaction.
    function flush() external nonReentrant {
        _forward();
    }

    /// @dev Protected forwarding: the operator is topped up to OPERATOR_GAS_TARGET and no further, so an operator
    ///      that does not need gas does not pull the factory's daily allowance out of the platform revenue.
    ///      A failed transfer never reverts; the reserve simply stays here.
    function _forward() private {
        address to = operator;
        uint256 held = address(this).balance;
        if (to == address(0) || held == 0) return;
        uint256 balance = to.balance;
        if (balance >= OPERATOR_GAS_TARGET) return;
        uint256 amount = OPERATOR_GAS_TARGET - balance;
        if (amount > held) amount = held;
        (bool success,) = to.call{value: amount}("");
        success; // intentionally ignored
    }
}
