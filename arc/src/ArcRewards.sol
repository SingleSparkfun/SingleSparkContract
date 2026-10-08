// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IRewardMarket {
    function trade(address token, bool buy, uint256 amountIn, uint256 minOut, uint256 deadline)
        external
        payable
        returns (uint256);
}

/// @notice Gas-sized direct distributions of 10 tokens per address, without random draws.
/// @dev The keeper indexes confirmed payouts for cross-transaction deduplication.
contract ArcRewards is ReentrancyGuard {
    using SafeERC20 for IERC20;
    uint256 public constant PAYOUT = 10e18;
    uint256 public constant MIN_RECIPIENTS = 100;
    IERC20 public immutable token;
    address public immutable launch;
    address public immutable keeper;
    uint256 public available;
    uint256 public pendingNative;
    uint256 public lastPurchaseAt;
    uint256 public roundId;
    uint256 public payoutCount;
    uint256 public totalPaid;

    event RewardFunded(uint256 amount);
    event RewardPurchased(uint256 nativeAmount, uint256 tokensBought);
    event RewardPaid(uint256 indexed roundId, uint256 indexed payoutIndex, address indexed recipient, uint256 amount);
    error Invalid();

    constructor(IERC20 token_, address launch_, address keeper_) {
        if (address(token_).code.length == 0 || launch_.code.length == 0 || keeper_ == address(0)) revert Invalid();
        token = token_;
        launch = launch_;
        keeper = keeper_;
    }

    // Direct batches finish atomically; no funds remain locked in an unfinished draw.
    function reserved() external pure returns (uint256) {
        return 0;
    }

    function nextPayoutIndex() external view returns (uint256) {
        return payoutCount;
    }

    function credit(uint256 amount) external {
        if (msg.sender != launch || amount == 0 || token.balanceOf(address(this)) < available + amount) {
            revert Invalid();
        }
        available += amount;
        emit RewardFunded(amount);
    }

    function fundNative() external payable {
        if (msg.sender != launch || msg.value == 0) revert Invalid();
        pendingNative += msg.value;
    }

    /// @notice Only this project's own token can be bought; all outputs stay in its rewards account.
    function buyOwnToken(uint256 expectedNative, uint256 minOut, uint256 deadline) external nonReentrant {
        if (
            msg.sender != keeper || expectedNative == 0 || expectedNative > pendingNative || minOut == 0
                || (lastPurchaseAt != 0 && block.timestamp < lastPurchaseAt + 180)
        ) {
            revert Invalid();
        }
        pendingNative -= expectedNative;
        lastPurchaseAt = block.timestamp;
        uint256 beforeBalance = token.balanceOf(address(this));
        uint256 bought =
            IRewardMarket(launch).trade{value: expectedNative}(address(token), true, expectedNative, minOut, deadline);
        if (bought < minOut || token.balanceOf(address(this)) - beforeBalance != bought) revert Invalid();
        available += bought;
        emit RewardPurchased(expectedNative, bought);
        emit RewardFunded(bought);
    }

    /// @notice No recipient-count cap: the keeper fits each transaction to its gas budget.
    function distribute(uint256 expectedTotalPaid, address[] calldata recipients) external nonReentrant {
        uint256 count = recipients.length;
        uint256 amount = count * PAYOUT;
        if (msg.sender != keeper || expectedTotalPaid != totalPaid || count < MIN_RECIPIENTS || amount > available) {
            revert Invalid();
        }
        available -= amount;
        totalPaid += count;
        roundId++;
        payoutCount = count;
        address previous;
        for (uint256 i; i < count; i++) {
            address recipient = recipients[i];
            if (
                recipient <= previous || recipient == address(this) || recipient == launch
                    || recipient == address(token) || recipient == keeper || recipient == address(0xdead)
            ) revert Invalid();
            previous = recipient;
            token.safeTransfer(recipient, PAYOUT);
            emit RewardPaid(roundId, i, recipient, PAYOUT);
        }
    }
}
