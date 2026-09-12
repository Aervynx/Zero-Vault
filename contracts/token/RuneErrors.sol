// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

library RuneErrors {
    error Rune__BlacklistedAccount(address account);
    error Rune__ZeroAddressProvided();
    error Rune__EcosystemPaused();
    error Rune__MaxSupplyExceeded(uint256 requested, uint256 allowed);
    error Rune__UnauthorizedAccess(address account, bytes32 neededRole);
}