//! Independently deployed DAO. Revenue/Claim instructions are not part of this program.
use solana_program::{
    account_info::AccountInfo, entrypoint::ProgramResult, program_error::ProgramError,
    pubkey::Pubkey,
};

#[path = "../../../src/accounts.rs"]
mod accounts;
#[path = "../../../src/configuration.rs"]
mod configuration;
#[path = "../../../src/governance.rs"]
mod governance;
#[path = "../../../src/state.rs"]
mod state;

#[cfg(not(feature = "no-entrypoint"))]
solana_program::entrypoint!(process_instruction);

pub fn process_instruction(
    program: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    let (tag, data) = data
        .split_first()
        .ok_or(ProgramError::InvalidInstructionData)?;
    match tag {
        0 => configuration::initialize(program, accounts, data),
        16..=20 => governance::process(program, accounts, *tag, data),
        _ => Err(ProgramError::InvalidInstructionData),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn dao_rejects_every_revenue_operation() {
        for tag in 1..=6 {
            assert_eq!(
                process_instruction(&Pubkey::new_unique(), &[], &[tag]),
                Err(ProgramError::InvalidInstructionData)
            );
        }
    }
}
