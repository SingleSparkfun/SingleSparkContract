//! Immutable, single-program upgrade controller. No arbitrary CPI or authority escape hatch.
#![allow(deprecated)]
use borsh::{BorshDeserialize, BorshSerialize};
use solana_program::{
    account_info::AccountInfo,
    bpf_loader_upgradeable as loader,
    clock::Clock,
    entrypoint::ProgramResult,
    hash::hash,
    program::{invoke, invoke_signed},
    program_error::ProgramError,
    pubkey::Pubkey,
    rent::Rent,
    system_instruction, system_program,
    sysvar::Sysvar,
};

#[path = "../../shared/loader.rs"]
mod loader_check;

pub const DELAY_SECONDS: i64 = 48 * 60 * 60;
// shortcut: one pending action per revenue program; use proposal PDAs when concurrent queues are needed.
#[derive(BorshSerialize, BorshDeserialize, Debug)]
pub struct Lock {
    pub program: Pubkey,
    pub admin: Pubkey,
    pub buffer: Pubkey,
    pub digest: [u8; 32],
    pub executable_at: i64,
    pub action: u8,
    pub config: Pubkey,
    pub parameters: [u8; 13],
    pub policy_revision: u64,
}
fn check(ok: bool) -> ProgramResult {
    if ok {
        Ok(())
    } else {
        Err(ProgramError::InvalidArgument)
    }
}
fn buffer_digest(buffer: &AccountInfo, authority: &Pubkey) -> Result<[u8; 32], ProgramError> {
    check(buffer.owner == &loader::ID && !buffer.executable)?;
    let data = buffer.try_borrow_data()?;
    check(
        data.len() > 37
            && data[..4] == 1u32.to_le_bytes()
            && data[4] == 1
            && &data[5..37] == authority.as_ref(),
    )?;
    Ok(hash(&data[37..]).to_bytes())
}
fn save(account: &AccountInfo, state: &Lock) -> ProgramResult {
    state
        .serialize(&mut &mut account.try_borrow_mut_data()?[..])
        .map_err(|_| ProgramError::AccountDataTooSmall)
}
#[cfg(not(feature = "no-entrypoint"))]
solana_program::entrypoint!(process_instruction);

pub fn process_instruction(program: &Pubkey, a: &[AccountInfo], data: &[u8]) -> ProgramResult {
    check(
        !data.is_empty()
            && (data.len() == 1 && data[0] <= 3
                || data.len() == 14 && data[0] == 4
                || data.len() == 2 && data[0] == 5),
    )?;
    match data[0] {
        // admin, lock, target, target ProgramData, self, self ProgramData, System, Loader
        0 => {
            check(
                a.len() == 8
                    && a[0].is_signer
                    && a[0].owner == &system_program::ID
                    && a[4].key == program
                    && a[2].key != program
                    && a[6].key == &system_program::ID
                    && a[7].key == &loader::ID,
            )?;
            check(loader_check::authority(&a[4], &a[5])?.is_none())?;
            check(loader_check::authority(&a[2], &a[3])? == Some(*a[0].key))?;
            let (address, bump) =
                Pubkey::find_program_address(&[b"upgrade", a[2].key.as_ref()], program);
            check(
                a[1].key == &address && a[1].owner == &system_program::ID && a[1].data_is_empty(),
            )?;
            let state = Lock {
                program: *a[2].key,
                admin: *a[0].key,
                buffer: Pubkey::default(),
                digest: [0; 32],
                executable_at: 0,
                action: 0,
                config: Pubkey::default(),
                parameters: [0; 13],
                policy_revision: 0,
            };
            let size = borsh::to_vec(&state)
                .map_err(|_| ProgramError::InvalidInstructionData)?
                .len();
            let rent = Rent::get()?
                .minimum_balance(size)
                .saturating_sub(a[1].lamports());
            if rent > 0 {
                invoke(&system_instruction::transfer(a[0].key, a[1].key, rent), a)?;
            }
            let seeds = &[b"upgrade".as_ref(), a[2].key.as_ref(), &[bump]];
            invoke_signed(
                &system_instruction::allocate(a[1].key, size as u64),
                a,
                &[seeds],
            )?;
            invoke_signed(&system_instruction::assign(a[1].key, program), a, &[seeds])?;
            save(&a[1], &state)?;
            invoke(
                &loader::set_upgrade_authority(a[2].key, a[0].key, Some(a[1].key)),
                a,
            )
        }
        // admin/spill, lock, target, target ProgramData, buffer, Loader, [Rent, Clock]
        1..=5 => {
            check(a.len() >= 6 && a.len() <= 9)?;
            check(a[1].owner == program && a[5].key == &loader::ID)?;
            let mut state = Lock::try_from_slice(&a[1].try_borrow_data()?)
                .map_err(|_| ProgramError::InvalidAccountData)?;
            let (address, bump) =
                Pubkey::find_program_address(&[b"upgrade", state.program.as_ref()], program);
            check(
                a[1].key == &address
                    && a[2].key == &state.program
                    && a[0].key == &state.admin
                    && loader_check::authority(&a[2], &a[3])? == Some(address),
            )?;
            let target = state.program;
            let seeds = &[b"upgrade".as_ref(), target.as_ref(), &[bump]];
            if data[0] == 1 || data[0] == 4 || data[0] == 5 {
                check(a.len() == if data[0] == 1 { 6 } else { 7 })?;
                check(a[0].is_signer && state.buffer == Pubkey::default())?;
                state.action = if data[0] == 1 {
                    0
                } else if data[0] == 4 {
                    1
                } else {
                    2
                };
                if state.action == 0 {
                    state.digest = buffer_digest(&a[4], a[0].key)?;
                    invoke(
                        &loader::set_buffer_authority(a[4].key, a[0].key, a[1].key),
                        a,
                    )?;
                } else {
                    check(a[4].owner == &state.program && a[6].owner == &state.program)?;
                    let project = a[4].try_borrow_data()?;
                    check(
                        project.len() >= 41
                            && project[0] == (if state.action == 1 { 7 } else { 8 })
                            && &project[1..33] == a[6].key.as_ref(),
                    )?;
                    state.policy_revision =
                        u64::from_le_bytes(project[project.len() - 8..].try_into().unwrap());
                    state.config = *a[6].key;
                    state.parameters = [0; 13];
                    state.parameters[..data.len() - 1].copy_from_slice(&data[1..]);
                    state.digest = hash(&data[1..]).to_bytes();
                }
                state.buffer = *a[4].key;
                state.executable_at = Clock::get()?
                    .unix_timestamp
                    .checked_add(DELAY_SECONDS)
                    .ok_or(ProgramError::ArithmeticOverflow)?;
                // Upgrade buffers are frozen before the waiting period begins.
            } else {
                check(state.buffer != Pubkey::default() && a[4].key == &state.buffer)?;
                if state.action == 0 {
                    check(buffer_digest(&a[4], a[1].key)? == state.digest)?;
                }
                if data[0] == 2 {
                    check(a[0].is_signer)?;
                    check(a.len() == 6)?;
                    if state.action == 0 {
                        invoke_signed(&loader::close(a[4].key, a[0].key, a[1].key), a, &[seeds])?;
                    }
                } else {
                    check(Clock::get()?.unix_timestamp >= state.executable_at)?;
                    if state.action == 0 {
                        check(a.len() == 8)?;
                        invoke_signed(
                            &loader::upgrade(a[2].key, a[4].key, a[1].key, a[0].key),
                            a,
                            &[seeds],
                        )?;
                    } else {
                        check(
                            a.len() == (if state.action == 1 { 9 } else { 7 })
                                && a[6].key == &state.config,
                        )?;
                        let mut payload = vec![if state.action == 1 { 8 } else { 10 }];
                        payload.extend_from_slice(&state.policy_revision.to_le_bytes());
                        payload.extend_from_slice(
                            &state.parameters[..if state.action == 1 { 13 } else { 1 }],
                        );
                        let mut accounts = vec![
                            solana_program::instruction::AccountMeta::new_readonly(*a[1].key, true),
                            solana_program::instruction::AccountMeta::new_readonly(
                                state.config,
                                false,
                            ),
                            solana_program::instruction::AccountMeta::new(state.buffer, false),
                        ];
                        if state.action == 1 {
                            accounts.extend(a[7..9].iter().map(|v| {
                                solana_program::instruction::AccountMeta::new_readonly(
                                    *v.key, false,
                                )
                            }));
                        }
                        invoke_signed(
                            &solana_program::instruction::Instruction {
                                program_id: state.program,
                                data: payload,
                                accounts,
                            },
                            a,
                            &[seeds],
                        )?;
                    }
                }
                state.buffer = Pubkey::default();
                state.digest = [0; 32];
                state.executable_at = 0;
            }
            save(&a[1], &state)
        }
        _ => Err(ProgramError::InvalidInstructionData),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn delay_has_no_short_test_or_admin_override() {
        assert_eq!(DELAY_SECONDS, 172800);
        for tag in [5, 255] {
            assert_eq!(
                process_instruction(&Pubkey::new_unique(), &[], &[tag]),
                Err(ProgramError::InvalidArgument)
            );
        }
        assert!(process_instruction(&Pubkey::new_unique(), &[], &[0, 0]).is_err());
    }
}
