#![allow(deprecated)]
use solana_program::{
    account_info::AccountInfo, bpf_loader_upgradeable as loader, program_error::ProgramError,
    pubkey::Pubkey,
};
pub fn authority(
    program: &AccountInfo,
    data: &AccountInfo,
) -> Result<Option<Pubkey>, ProgramError> {
    if program.owner != &loader::ID
        || !program.executable
        || data.owner != &loader::ID
        || data.key != &loader::get_program_data_address(program.key)
    {
        return Err(ProgramError::InvalidAccountData);
    }
    let p = program.try_borrow_data()?;
    let d = data.try_borrow_data()?;
    if p.len() != 36
        || p[..4] != 2u32.to_le_bytes()
        || &p[4..] != data.key.as_ref()
        || d.len() < 45
        || d[..4] != 3u32.to_le_bytes()
        || d[12] > 1
    {
        return Err(ProgramError::InvalidAccountData);
    }
    Ok(if d[12] == 0 {
        None
    } else {
        Some(Pubkey::new_from_array(d[13..45].try_into().unwrap()))
    })
}
