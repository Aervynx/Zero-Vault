// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import "@openzeppelin/contracts/token/ERC721/utils/ERC721Holder.sol";
import "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "../access/RoleManager.sol";
import "../security/EmergencyPause.sol";
import "../interfaces/IERC4907.sol";

/**
 * @title CollateralLending
 * @author ZeroVault Lead Architect
 * @notice Isolated fixed-term installment lending module supporting ETH, whitelisted ERC20,
 *         and Genesis ERC721/ERC4907 NFTs as collateral, with Grace Period, Late Fee,
 *         single-tx full repayment, automatic ERC-4907 utility preservation, and Dual Liquidation.
 */
contract CollateralLending is ReentrancyGuard, ERC721Holder {
    using SafeERC20 for IERC20;

    enum CollateralType {
        None,
        ETH,
        ERC20,
        ERC721
    }

    enum LoanStatus {
        None,
        Active,
        Repaid,
        Liquidated
    }

    struct CollateralConfig {
        CollateralType collateralType;
        bool enabled;
        uint256 maxLoanPerUnit; // For ERC721: max loan per NFT; for ETH/ERC20: max loan per 1e18 units
        uint16 interestBps;     // Total fixed interest in bps (e.g., 500 = 5%)
        uint16 lateFeeBps;      // Late fee in bps on overdue installment (e.g., 200 = 2%)
        uint256 gracePeriod;    // Grace window after due date before liquidation (e.g., 3 days)
    }

    struct Loan {
        address borrower;
        CollateralType collateralType;
        address collateralAsset;      // address(0) for ETH
        uint256 collateralAmountOrId; // wei/token amount or ERC721 tokenId
        uint256 totalOwed;
        uint256 totalPaid;
        uint8 totalInstallments;
        uint8 installmentsPaid;
        uint256 installmentInterval;
        uint256 nextDueTime;
        uint256 gracePeriod;
        uint16 lateFeeBps;
        LoanStatus status;
    }

    uint256 public constant BPS_DENOMINATOR = 10_000;
    uint8 public constant MAX_INSTALLMENTS = 12;
    uint256 public constant MIN_INTERVAL = 1 days;
    uint256 public constant MAX_INTERVAL = 90 days;

    IERC20 public immutable loanToken;
    RoleManager public immutable roleManager;
    EmergencyPause public immutable emergencyPause;
    address public immutable treasuryVault;
    address public immutable timelock;

    uint256 public nextLoanId = 1;
    mapping(address => CollateralConfig) public collateralConfigs; // address(0) for ETH
    mapping(uint256 => Loan) public loans;

    // Tracks locked ERC20 collateral separately if collateralAsset == loanToken
    mapping(address => uint256) public lockedERC20Collateral;

    event CollateralConfigured(
        address indexed asset,
        CollateralType indexed collateralType,
        uint256 maxLoanPerUnit,
        uint16 interestBps,
        uint16 lateFeeBps,
        uint256 gracePeriod
    );
    event PoolFunded(address indexed sender, uint256 amount);
    event PoolLiquidityWithdrawn(address indexed to, uint256 amount);
    event LoanCreated(
        uint256 indexed loanId,
        address indexed borrower,
        CollateralType collateralType,
        address indexed collateralAsset,
        uint256 collateralAmountOrId,
        uint256 principal,
        uint256 totalOwed,
        uint8 totalInstallments
    );
    event InstallmentRepaid(
        uint256 indexed loanId,
        address indexed payer,
        uint8 installmentNumber,
        uint256 amountPaid,
        uint256 lateFee
    );
    event LoanRepaidInFull(uint256 indexed loanId, address indexed borrower);
    event LoanLiquidated(
        uint256 indexed loanId,
        address indexed liquidator,
        uint256 debtRecovered
    );
    event CollateralSeizedToTreasury(uint256 indexed loanId, address indexed triggeredBy);

    error CollateralLending__ZeroAddress();
    error CollateralLending__ZeroAmount();
    error CollateralLending__Unauthorized();
    error CollateralLending__InvalidConfig();
    error CollateralLending__CollateralNotEnabled();
    error CollateralLending__InvalidLoanTerms();
    error CollateralLending__ExceedsMaxLoan();
    error CollateralLending__InsufficientPoolLiquidity();
    error CollateralLending__FeeOnTransferNotSupported();
    error CollateralLending__LoanNotActive();
    error CollateralLending__LoanNotDefaulted();
    error CollateralLending__ETHTransferFailed();

    constructor(
        address _loanToken,
        address _roleManager,
        address _emergencyPause,
        address _treasuryVault,
        address _timelock
    ) {
        if (
            _loanToken == address(0) ||
            _roleManager == address(0) ||
            _emergencyPause == address(0) ||
            _treasuryVault == address(0) ||
            _timelock == address(0)
        ) {
            revert CollateralLending__ZeroAddress();
        }
        loanToken = IERC20(_loanToken);
        roleManager = RoleManager(_roleManager);
        emergencyPause = EmergencyPause(_emergencyPause);
        treasuryVault = _treasuryVault;
        timelock = _timelock;
    }

    /**
     * @notice Configures an eligible collateral asset (ETH via address(0), ERC20, or Genesis ERC721).
     */
    function configureCollateral(address asset, CollateralConfig calldata cfg) external {
        if (!roleManager.isBudgetManager(msg.sender) && !roleManager.isAdmin(msg.sender)) {
            revert CollateralLending__Unauthorized();
        }
        if (cfg.collateralType == CollateralType.None || cfg.maxLoanPerUnit == 0) {
            revert CollateralLending__InvalidConfig();
        }
        if (cfg.interestBps > 5000 || cfg.lateFeeBps > 2000) {
            revert CollateralLending__InvalidConfig();
        }
        if (cfg.collateralType == CollateralType.ETH && asset != address(0)) {
            revert CollateralLending__InvalidConfig();
        }
        if (cfg.collateralType != CollateralType.ETH && asset == address(0)) {
            revert CollateralLending__ZeroAddress();
        }
        if (cfg.collateralType == CollateralType.ERC721) {
            try IERC165(asset).supportsInterface(type(IERC721).interfaceId) returns (bool ok) {
                if (!ok) revert CollateralLending__InvalidConfig();
            } catch {
                revert CollateralLending__InvalidConfig();
            }
        }

        collateralConfigs[asset] = cfg;
        emit CollateralConfigured(
            asset,
            cfg.collateralType,
            cfg.maxLoanPerUnit,
            cfg.interestBps,
            cfg.lateFeeBps,
            cfg.gracePeriod
        );
    }

    /**
     * @notice Returns available loanToken liquidity excluding any locked user collateral.
     */
    function availablePoolLiquidity() public view returns (uint256) {
        uint256 bal = loanToken.balanceOf(address(this));
        uint256 locked = lockedERC20Collateral[address(loanToken)];
        return bal > locked ? bal - locked : 0;
    }

    /**
     * @notice Funds the lending pool with loanToken. Rejects fee-on-transfer tokens.
     */
    function fundPool(uint256 amount) external nonReentrant {
        if (amount == 0) revert CollateralLending__ZeroAmount();
        uint256 beforeBal = loanToken.balanceOf(address(this));
        loanToken.safeTransferFrom(msg.sender, address(this), amount);
        if (loanToken.balanceOf(address(this)) - beforeBal != amount) {
            revert CollateralLending__FeeOnTransferNotSupported();
        }
        emit PoolFunded(msg.sender, amount);
    }

    /**
     * @notice Withdraws unencumbered lending liquidity back to TreasuryVault. Timelock only.
     */
    function withdrawPoolLiquidity(uint256 amount) external nonReentrant {
        if (msg.sender != timelock) revert CollateralLending__Unauthorized();
        emergencyPause.requireNotPaused();
        if (amount == 0) revert CollateralLending__ZeroAmount();
        if (availablePoolLiquidity() < amount) revert CollateralLending__InsufficientPoolLiquidity();

        loanToken.safeTransfer(treasuryVault, amount);
        emit PoolLiquidityWithdrawn(treasuryVault, amount);
    }

    /**
     * @notice Locks ETH as collateral and disburses an installment loan in loanToken.
     */
    function borrowWithETH(
        uint256 principal,
        uint8 installments,
        uint256 interval
    ) external payable nonReentrant returns (uint256 loanId) {
        emergencyPause.requireNotPaused();
        if (msg.value == 0 || principal == 0) revert CollateralLending__ZeroAmount();

        CollateralConfig storage cfg = collateralConfigs[address(0)];
        if (!cfg.enabled || cfg.collateralType != CollateralType.ETH) {
            revert CollateralLending__CollateralNotEnabled();
        }

        uint256 maxLoan = (msg.value * cfg.maxLoanPerUnit) / 1e18;
        if (principal > maxLoan) revert CollateralLending__ExceedsMaxLoan();

        loanId = _openLoan(
            CollateralType.ETH,
            address(0),
            msg.value,
            principal,
            installments,
            interval,
            cfg
        );
    }

    /**
     * @notice Locks whitelisted ERC20 tokens as collateral and disburses an installment loan.
     */
    function borrowWithERC20(
        address token,
        uint256 collateralAmount,
        uint256 principal,
        uint8 installments,
        uint256 interval
    ) external nonReentrant returns (uint256 loanId) {
        emergencyPause.requireNotPaused();
        if (token == address(0)) revert CollateralLending__ZeroAddress();
        if (collateralAmount == 0 || principal == 0) revert CollateralLending__ZeroAmount();

        CollateralConfig storage cfg = collateralConfigs[token];
        if (!cfg.enabled || cfg.collateralType != CollateralType.ERC20) {
            revert CollateralLending__CollateralNotEnabled();
        }

        uint256 maxLoan = (collateralAmount * cfg.maxLoanPerUnit) / 1e18;
        if (principal > maxLoan) revert CollateralLending__ExceedsMaxLoan();

        uint256 beforeBal = IERC20(token).balanceOf(address(this));
        IERC20(token).safeTransferFrom(msg.sender, address(this), collateralAmount);
        if (IERC20(token).balanceOf(address(this)) - beforeBal != collateralAmount) {
            revert CollateralLending__FeeOnTransferNotSupported();
        }
        lockedERC20Collateral[token] += collateralAmount;

        loanId = _openLoan(
            CollateralType.ERC20,
            token,
            collateralAmount,
            principal,
            installments,
            interval,
            cfg
        );
    }

    /**
     * @notice Locks a whitelisted Genesis ERC721/ERC4907 NFT as collateral and disburses an installment loan.
     */
    function borrowWithGenesisNFT(
        address nft,
        uint256 tokenId,
        uint256 principal,
        uint8 installments,
        uint256 interval
    ) external nonReentrant returns (uint256 loanId) {
        emergencyPause.requireNotPaused();
        if (nft == address(0)) revert CollateralLending__ZeroAddress();
        if (principal == 0) revert CollateralLending__ZeroAmount();

        CollateralConfig storage cfg = collateralConfigs[nft];
        if (!cfg.enabled || cfg.collateralType != CollateralType.ERC721) {
            revert CollateralLending__CollateralNotEnabled();
        }
        if (principal > cfg.maxLoanPerUnit) revert CollateralLending__ExceedsMaxLoan();

        IERC721(nft).safeTransferFrom(msg.sender, address(this), tokenId);

        loanId = _openLoan(
            CollateralType.ERC721,
            nft,
            tokenId,
            principal,
            installments,
            interval,
            cfg
        );
    }

    /**
     * @notice Repays the next installment (plus late fee if overdue).
     * @dev Intentionally ALLOWED even during EmergencyPause so borrowers can always avoid default.
     */
    function repayInstallment(uint256 loanId) external nonReentrant {
        Loan storage loan = loans[loanId];
        if (loan.status != LoanStatus.Active) revert CollateralLending__LoanNotActive();

        uint256 remainingDebt = loan.totalOwed - loan.totalPaid;
        uint8 nextNumber = loan.installmentsPaid + 1;
        uint256 installmentAmount = (nextNumber == loan.totalInstallments)
            ? remainingDebt
            : (loan.totalOwed / loan.totalInstallments);

        uint256 lateFee = 0;
        if (block.timestamp > loan.nextDueTime) {
            lateFee = (installmentAmount * loan.lateFeeBps) / BPS_DENOMINATOR;
        }

        uint256 totalPayment = installmentAmount + lateFee;
        loanToken.safeTransferFrom(msg.sender, address(this), totalPayment);

        loan.totalPaid += installmentAmount;
        loan.installmentsPaid = nextNumber;
        loan.nextDueTime += loan.installmentInterval;

        emit InstallmentRepaid(loanId, msg.sender, nextNumber, installmentAmount, lateFee);

        if (loan.totalPaid >= loan.totalOwed) {
            loan.status = LoanStatus.Repaid;
            _releaseCollateral(loan, loan.borrower);
            emit LoanRepaidInFull(loanId, loan.borrower);
        } else {
            _syncGenesisNFTUtility(loan, loan.borrower, loan.nextDueTime + loan.gracePeriod);
        }
    }

    /**
     * @notice Repays the entire remaining balance in a single transaction and immediately releases collateral.
     * @dev Intentionally ALLOWED even during EmergencyPause so borrowers can always settle and recover assets.
     */
    function repayFull(uint256 loanId) external nonReentrant {
        Loan storage loan = loans[loanId];
        if (loan.status != LoanStatus.Active) revert CollateralLending__LoanNotActive();

        uint256 remainingDebt = loan.totalOwed - loan.totalPaid;
        uint256 lateFee = 0;
        if (block.timestamp > loan.nextDueTime) {
            lateFee = (remainingDebt * loan.lateFeeBps) / BPS_DENOMINATOR;
        }

        loanToken.safeTransferFrom(msg.sender, address(this), remainingDebt + lateFee);

        // CEI: finalize loan state before releasing collateral
        loan.totalPaid = loan.totalOwed;
        loan.installmentsPaid = loan.totalInstallments;
        loan.status = LoanStatus.Repaid;

        emit InstallmentRepaid(loanId, msg.sender, loan.totalInstallments, remainingDebt, lateFee);
        _releaseCollateral(loan, loan.borrower);
        emit LoanRepaidInFull(loanId, loan.borrower);
    }

    /**
     * @notice Returns true if a loan has passed both its due date and grace period without payment.
     */
    function isDefaulted(uint256 loanId) public view returns (bool) {
        Loan storage loan = loans[loanId];
        return loan.status == LoanStatus.Active && block.timestamp > loan.nextDueTime + loan.gracePeriod;
    }

    /**
     * @notice Default Resolution Path 1: Any liquidator repays remaining debt + late fee to make the pool
     *         100% whole and claims the defaulted collateral.
     */
    function liquidate(uint256 loanId) external nonReentrant {
        emergencyPause.requireNotPaused();
        if (!isDefaulted(loanId)) revert CollateralLending__LoanNotDefaulted();

        Loan storage loan = loans[loanId];
        uint256 remainingDebt = loan.totalOwed - loan.totalPaid;
        uint256 lateFee = (remainingDebt * loan.lateFeeBps) / BPS_DENOMINATOR;
        uint256 payoff = remainingDebt + lateFee;

        // CEI: mark liquidated before external calls
        loan.status = LoanStatus.Liquidated;

        loanToken.safeTransferFrom(msg.sender, address(this), payoff);
        _releaseCollateral(loan, msg.sender);

        emit LoanLiquidated(loanId, msg.sender, payoff);
    }

    /**
     * @notice Default Resolution Path 2: Operator or Admin seizes defaulted collateral directly into TreasuryVault.
     */
    function seizeToTreasury(uint256 loanId) external nonReentrant {
        emergencyPause.requireNotPaused();
        if (!roleManager.isOperator(msg.sender) && !roleManager.isAdmin(msg.sender)) {
            revert CollateralLending__Unauthorized();
        }
        if (!isDefaulted(loanId)) revert CollateralLending__LoanNotDefaulted();

        Loan storage loan = loans[loanId];
        loan.status = LoanStatus.Liquidated;

        _releaseCollateral(loan, treasuryVault);
        emit CollateralSeizedToTreasury(loanId, msg.sender);
    }

    function _openLoan(
        CollateralType cType,
        address cAsset,
        uint256 cAmountOrId,
        uint256 principal,
        uint8 installments,
        uint256 interval,
        CollateralConfig storage cfg
    ) internal returns (uint256 loanId) {
        if (
            installments == 0 ||
            installments > MAX_INSTALLMENTS ||
            interval < MIN_INTERVAL ||
            interval > MAX_INTERVAL
        ) {
            revert CollateralLending__InvalidLoanTerms();
        }
        if (availablePoolLiquidity() < principal) {
            revert CollateralLending__InsufficientPoolLiquidity();
        }

        uint256 totalOwed = principal + (principal * cfg.interestBps) / BPS_DENOMINATOR;
        loanId = nextLoanId++;

        loans[loanId] = Loan({
            borrower: msg.sender,
            collateralType: cType,
            collateralAsset: cAsset,
            collateralAmountOrId: cAmountOrId,
            totalOwed: totalOwed,
            totalPaid: 0,
            totalInstallments: installments,
            installmentsPaid: 0,
            installmentInterval: interval,
            nextDueTime: block.timestamp + interval,
            gracePeriod: cfg.gracePeriod,
            lateFeeBps: cfg.lateFeeBps,
            status: LoanStatus.Active
        });

        _syncGenesisNFTUtility(loans[loanId], msg.sender, block.timestamp + interval + cfg.gracePeriod);

        loanToken.safeTransfer(msg.sender, principal);

        emit LoanCreated(
            loanId,
            msg.sender,
            cType,
            cAsset,
            cAmountOrId,
            principal,
            totalOwed,
            installments
        );
    }

    function _releaseCollateral(Loan storage loan, address recipient) internal {
        if (loan.collateralType == CollateralType.ETH) {
            (bool success, ) = payable(recipient).call{value: loan.collateralAmountOrId}("");
            if (!success) revert CollateralLending__ETHTransferFailed();
        } else if (loan.collateralType == CollateralType.ERC20) {
            lockedERC20Collateral[loan.collateralAsset] -= loan.collateralAmountOrId;
            IERC20(loan.collateralAsset).safeTransfer(recipient, loan.collateralAmountOrId);
        } else if (loan.collateralType == CollateralType.ERC721) {
            _syncGenesisNFTUtility(loan, address(0), 0);
            IERC721(loan.collateralAsset).safeTransferFrom(
                address(this),
                recipient,
                loan.collateralAmountOrId
            );
        }
    }

    /**
     * @dev If a locked Genesis NFT supports ERC-4907, automatically keeps utility delegated
     *      to the borrower while the loan is healthy, and clears/expires it on default or release.
     */
    function _syncGenesisNFTUtility(Loan storage loan, address user, uint256 expires) internal {
        if (loan.collateralType != CollateralType.ERC721) return;
        try IERC165(loan.collateralAsset).supportsInterface(type(IERC4907).interfaceId) returns (
            bool is4907
        ) {
            if (is4907) {
                IERC4907(loan.collateralAsset).setUser(
                    loan.collateralAmountOrId,
                    user,
                    uint64(expires)
                );
            }
        } catch {}
    }
}