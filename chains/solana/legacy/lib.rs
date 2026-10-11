//! Custodial Pump revenue plugins and token-locked governance. No private keys enter this program.
use solana_program::{account_info::AccountInfo, entrypoint::ProgramResult, pubkey::Pubkey};

#[path = "../shared/accounts.rs"]
mod accounts;
#[path = "../shared/loader.rs"]
mod loader;
#[path = "../shared/configuration.rs"]
mod configuration;
#[path = "../governance/governance.rs"]
pub mod governance;
#[path = "../launchpads/pump/revenue.rs"]
pub mod revenue;
#[path = "../shared/state.rs"]
pub mod state;

#[cfg(not(feature = "no-entrypoint"))]
solana_program::entrypoint!(process_instruction);

pub fn process_instruction(
    program: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    let (tag, data) = data
        .split_first()
        .ok_or(solana_program::program_error::ProgramError::InvalidInstructionData)?;
    match tag {
        0..=10 => revenue::process(program, accounts, *tag, data),
        16..=20 => governance::process(program, accounts, *tag, data),
        _ => Err(solana_program::program_error::ProgramError::InvalidInstructionData),
    }
}
