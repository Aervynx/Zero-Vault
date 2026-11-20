// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "../access/RoleManager.sol";
import "../security/EmergencyPause.sol";

/**
 * @title TreasuryVesting
 * @author ZeroVault Lead Architect
 * @notice Token-agnostic on-chain vesting module supporting TGE unlocks, cliffs,
 *         continuous linear releases, and stepped/quarterly vesting schedules.
 */
contract TreasuryVesting is ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct ScheduleParams {
        address token;
        address beneficiary;
        uint256 totalAmount;
        uint256 tgeAmount;
        uint256 startTime;
        uint256 cliffDuration;
        uint256 duration;
        uint256 slicePeriod; // 1 = continuous linear, e.g. 90 days = quarterly
        bool revocable;
    }

    struct VestingSchedule {
        address token;
        address beneficiary;
        uint256 totalAmount;
        uint256 tgeAmount;
        uint256 startTime;
        uint256 cliffDuration;
        uint256 duration;
        uint256 slicePeriod;
        uint256 released;
        bool revocable;
        bool revoked;
    }

    RoleManager public immutable roleManager;
    EmergencyPause public immutable emergencyPause;
    address public immutable timelock;

    uint256 public nextScheduleId = 1;
    mapping(uint256 => VestingSchedule) public schedules;

    event ScheduleCreated(
        uint256 indexed scheduleId,
        address indexed token,
        address indexed beneficiary,
        uint256 totalAmount,
        uint256 tgeAmount,
        uint256 startTime,
        uint256 cliffDuration,
        uint256 duration
    );
    event TokensClaimed(
        uint256 indexed scheduleId,
        address indexed token,
        address indexed beneficiary,
        uint256 amount
    );
    event ScheduleRevoked(
        uint256 indexed scheduleId,
        address indexed refundTo,
        uint256 unvestedRefunded
    );

    error TreasuryVesting__ZeroAddress();
    error TreasuryVesting__Unauthorized();
    error TreasuryVesting__InvalidScheduleParams();
    error TreasuryVesting__FeeOnTransferNotSupported();
    error TreasuryVesting__ScheduleNotFound();
    error TreasuryVesting__NothingToClaim();
    error TreasuryVesting__NotRevocable();
    error TreasuryVesting__AlreadyRevoked();

    constructor(address _roleManager, address _emergencyPause, address _timelock) {
        if (_roleManager == address(0) || _emergencyPause == address(0) || _timelock == address(0)) {
            revert TreasuryVesting__ZeroAddress();
        }
        roleManager = RoleManager(_roleManager);
        emergencyPause = EmergencyPause(_emergencyPause);
        timelock = _timelock;
    }

    /**
     * @notice Creates and funds a vesting schedule. Callable by DEFAULT_ADMIN_ROLE or Timelock.
     * @dev Pulls `params.totalAmount` from msg.sender and rejects fee-on-transfer tokens.
     */
    function createSchedule(
        ScheduleParams calldata params
    ) external nonReentrant returns (uint256 scheduleId) {
        if (!roleManager.isAdmin(msg.sender) && msg.sender != timelock) {
            revert TreasuryVesting__Unauthorized();
        }
        if (params.token == address(0) || params.beneficiary == address(0)) {
            revert TreasuryVesting__ZeroAddress();
        }
        if (
            params.totalAmount == 0 ||
            params.tgeAmount > params.totalAmount ||
            params.duration == 0 ||
            params.slicePeriod == 0 ||
            params.slicePeriod > params.duration
        ) {
            revert TreasuryVesting__InvalidScheduleParams();
        }

        uint256 balanceBefore = IERC20(params.token).balanceOf(address(this));
        IERC20(params.token).safeTransferFrom(msg.sender, address(this), params.totalAmount);
        uint256 received = IERC20(params.token).balanceOf(address(this)) - balanceBefore;
        if (received != params.totalAmount) revert TreasuryVesting__FeeOnTransferNotSupported();

        scheduleId = nextScheduleId++;
        schedules[scheduleId] = VestingSchedule({
            token: params.token,
            beneficiary: params.beneficiary,
            totalAmount: params.totalAmount,
            tgeAmount: params.tgeAmount,
            startTime: params.startTime,
            cliffDuration: params.cliffDuration,
            duration: params.duration,
            slicePeriod: params.slicePeriod,
            released: 0,
            revocable: params.revocable,
            revoked: false
        });

        emit ScheduleCreated(
            scheduleId,
            params.token,
            params.beneficiary,
            params.totalAmount,
            params.tgeAmount,
            params.startTime,
            params.cliffDuration,
            params.duration
        );
    }

    /**
     * @notice Computes total vested amount for a schedule at the current block timestamp.
     */
    function vestedAmount(uint256 scheduleId) public view returns (uint256) {
        VestingSchedule storage s = schedules[scheduleId];
        if (s.totalAmount == 0) revert TreasuryVesting__ScheduleNotFound();

        if (s.revoked) {
            return s.totalAmount;
        }
        if (block.timestamp < s.startTime) {
            return 0;
        }
        uint256 cliffEnd = s.startTime + s.cliffDuration;
        if (block.timestamp < cliffEnd) {
            return s.tgeAmount;
        }
        if (block.timestamp >= cliffEnd + s.duration) {
            return s.totalAmount;
        }

        uint256 elapsedAfterCliff = block.timestamp - cliffEnd;
        uint256 vestedTime = (elapsedAfterCliff / s.slicePeriod) * s.slicePeriod;
        uint256 postCliffTotal = s.totalAmount - s.tgeAmount;

        return s.tgeAmount + (postCliffTotal * vestedTime) / s.duration;
    }

    /**
     * @notice Returns the currently claimable amount for a schedule.
     */
    function claimableAmount(uint256 scheduleId) public view returns (uint256) {
        VestingSchedule storage s = schedules[scheduleId];
        uint256 vested = vestedAmount(scheduleId);
        if (vested <= s.released) return 0;
        return vested - s.released;
    }

    /**
     * @notice Claims all currently vested tokens for a schedule. Callable by the beneficiary while unpaused.
     */
    function claim(uint256 scheduleId) external nonReentrant {
        emergencyPause.requireNotPaused();

        VestingSchedule storage s = schedules[scheduleId];
        if (s.totalAmount == 0) revert TreasuryVesting__ScheduleNotFound();
        if (msg.sender != s.beneficiary) revert TreasuryVesting__Unauthorized();

        uint256 amount = claimableAmount(scheduleId);
        if (amount == 0) revert TreasuryVesting__NothingToClaim();

        // CEI: update released before transfer
        s.released += amount;
        IERC20(s.token).safeTransfer(s.beneficiary, amount);

        emit TokensClaimed(scheduleId, s.token, s.beneficiary, amount);
    }

    /**
     * @notice Revokes a revocable schedule and refunds unvested tokens to `refundTo` (e.g., TreasuryVault).
     * @dev Strictly gated by Timelock so no single admin can unilaterally cancel vesting.
     *      Already-vested tokens remain claimable by the beneficiary.
     */
    function revokeSchedule(uint256 scheduleId, address refundTo) external nonReentrant {
        if (msg.sender != timelock) revert TreasuryVesting__Unauthorized();
        if (refundTo == address(0)) revert TreasuryVesting__ZeroAddress();

        VestingSchedule storage s = schedules[scheduleId];
        if (s.totalAmount == 0) revert TreasuryVesting__ScheduleNotFound();
        if (!s.revocable) revert TreasuryVesting__NotRevocable();
        if (s.revoked) revert TreasuryVesting__AlreadyRevoked();

        uint256 vested = vestedAmount(scheduleId);
        uint256 unvested = s.totalAmount - vested;

        s.totalAmount = vested;
        s.revoked = true;

        if (unvested > 0) {
            IERC20(s.token).safeTransfer(refundTo, unvested);
        }

        emit ScheduleRevoked(scheduleId, refundTo, unvested);
    }
}