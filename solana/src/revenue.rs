use crate::{accounts::*, state::*};
use borsh::{BorshDeserialize, BorshSerialize};
use solana_program::{
    account_info::AccountInfo,
    clock::Clock,
    entrypoint::ProgramResult,
    instruction::{AccountMeta, Instruction},
    program::invoke_signed,
    program_error::ProgramError,
    program_pack::Pack,
    pubkey::Pubkey,
    rent::Rent,
    system_instruction,
    sysvar::Sysvar,
};

pub use crate::configuration::Args as ConfigArgs;
#[derive(BorshDeserialize, BorshSerialize, Debug)]
pub struct ProjectArgs {
    pub buyback: bool,
    pub distribution: bool,
    pub reserve_recipient: Pubkey,
    pub timelock: Pubkey,
}
#[derive(BorshDeserialize, BorshSerialize, Debug)]
pub struct Meta {
    pub index: u8,
    pub signer: bool,
    pub writable: bool,
}
#[derive(BorshDeserialize, BorshSerialize, Debug)]
pub struct Step {
    pub program: u8,
    pub accounts: Vec<Meta>,
    pub data: Vec<u8>,
}
#[derive(BorshDeserialize, BorshSerialize, Debug)]
pub struct CollectArgs {
    pub nonce: u64,
    pub steps: Vec<Step>,
}
#[derive(BorshDeserialize, BorshSerialize, Debug)]
pub struct BuyArgs {
    pub nonce: u64,
    pub kind: u8,
    pub max_debit: u64,
    pub min_tokens: u64,
    pub min_reward: u64,
    pub sponsor_rent: u64,
    pub deadline: i64,
    pub steps: Vec<Step>,
}
#[derive(BorshDeserialize, BorshSerialize, Debug)]
pub struct PayoutArgs {
    pub nonce: u64,
    pub min_reward: u64,
    pub deadline: i64,
}
#[derive(BorshDeserialize, BorshSerialize, Debug)]
pub struct WithdrawArgs {
    pub nonce: u64,
    pub bucket: u8,
    pub amount: u64,
}

fn args<T: BorshDeserialize>(data: &[u8]) -> Result<T> {
    T::try_from_slice(data).map_err(|_| ProgramError::InvalidInstructionData)
}
fn account<'a, 'b>(a: &'b [AccountInfo<'a>], i: usize) -> Result<&'b AccountInfo<'a>> {
    a.get(i).ok_or(ProgramError::NotEnoughAccountKeys)
}
fn instruction(step: &Step, a: &[AccountInfo]) -> Result<Instruction> {
    require(step.accounts.len() <= 40 && step.data.len() <= 32)?;
    Ok(Instruction {
        program_id: *account(a, step.program as usize)?.key,
        accounts: step
            .accounts
            .iter()
            .map(|m| {
                Ok(AccountMeta {
                    pubkey: *account(a, m.index as usize)?.key,
                    is_signer: m.signer,
                    is_writable: m.writable,
                })
            })
            .collect::<Result<_>>()?,
        data: step.data.clone(),
    })
}
fn key(ix: &Instruction, i: usize) -> Result<&Pubkey> {
    ix.accounts
        .get(i)
        .map(|m| &m.pubkey)
        .ok_or(ProgramError::NotEnoughAccountKeys)
}
fn common(program: &Pubkey, a: &[AccountInfo], nonce: u64) -> Result<(Config, Project)> {
    require(a.len() >= 5)?;
    signer(&a[0])?;
    wallet(&a[0])?;
    require(
        a[3].owner == &solana_program::system_program::ID
            && a[3].data_is_empty()
            && !a[3].executable,
    )?;
    require(a[0].key != a[3].key && a[4].key == &solana_program::system_program::ID)?;
    let c: Config = load(program, &a[1], 1)?;
    pda(program, &a[1], &[b"config", c.authority.as_ref()])?;
    let p: Project = load(program, &a[2], 7)?;
    pda(
        program,
        &a[3],
        &[b"hook-vault", p.config.as_ref(), p.mint.as_ref()],
    )?;
    pda(program, &a[2], &[b"project", p.hook.as_ref()])?;
    require(p.config == *a[1].key && p.hook == *a[3].key && p.nonce == nonce)?;
    p.conserve()?;
    Ok((c, p))
}
fn wrapped(a: &AccountInfo, hook: &AccountInfo) -> Result<u64> {
    require(a.key == &ata(hook.key, &NATIVE, &spl_token::ID))?;
    token(a, &NATIVE, hook.key, &spl_token::ID)
}
fn deadline(value: i64) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    require(
        value >= now
            && value
                <= now
                    .checked_add(60)
                    .ok_or(ProgramError::ArithmeticOverflow)?,
    )
}
fn finish(
    program: &Pubkey,
    a: &[AccountInfo],
    p: &mut Project,
    kind: u8,
    debit: u64,
    tokens: u64,
    reward: u64,
) -> Result<()> {
    vault_transfer(program, p, &a[3], &a[0], &a[4], reward)?;
    p.nonce = add(p.nonce, 1)?;
    p.conserve()?;
    save(&a[2], 7, p)?;
    solana_program::log::sol_log_data(&[
        b"SingleSparkRevenueV1",
        a[2].key.as_ref(),
        &[kind],
        &p.nonce.to_le_bytes(),
        &debit.to_le_bytes(),
        &tokens.to_le_bytes(),
        &reward.to_le_bytes(),
    ]);
    Ok(())
}

fn process_inner(program: &Pubkey, a: &[AccountInfo], tag: u8, data: &[u8]) -> ProgramResult {
    match tag {
        0 => crate::configuration::initialize(program, a, data),
        1 => {
            require(a.len() == 13)?;
            let v: ProjectArgs = args(data)?;
            let c: Config = load(program, &a[2], 1)?;
            pda(program, &a[2], &[b"config", c.authority.as_ref()])?;
            signer(&a[1])?;
            require(
                a[4].owner == &solana_program::system_program::ID
                    && a[4].data_is_empty()
                    && !a[4].executable,
            )?;
            pda(
                program,
                &a[4],
                &[b"hook-vault", a[2].key.as_ref(), a[5].key.as_ref()],
            )?;
            let rent = Rent::get()?
                .minimum_balance(0)
                .saturating_sub(a[4].lamports());
            transfer_sol(&a[0], &a[4], &a[7], rent)?;
            require(
                c.authority == *a[1].key
                    && signing_address(&v.reserve_recipient)
                    && v.reserve_recipient != *a[4].key
                    && v.reserve_recipient != *a[5].key,
            )?;
            mint(&a[5])?;
            curve(&a[6], a[5].key, Some(a[4].key))?;
            require(
                a[11].key == program
                    && a[9].key == &v.timelock
                    && crate::loader::authority(&a[9], &a[10])?.is_none()
                    && crate::loader::authority(&a[11], &a[8])?
                        == Some(
                            Pubkey::find_program_address(
                                &[b"upgrade", program.as_ref()],
                                &v.timelock,
                            )
                            .0,
                        ),
            )?;
            if a[12].data_is_empty() {
                create(
                    program,
                    &a[0],
                    &a[12],
                    &a[7],
                    &[b"plugins", a[2].key.as_ref()],
                    8,
                    &PluginGate {
                        config: *a[2].key,
                        timelock: v.timelock,
                        paused: 0,
                        revision: 0,
                    },
                )?;
            }
            let gate: PluginGate = load(program, &a[12], 8)?;
            pda(program, &a[12], &[b"plugins", a[2].key.as_ref()])?;
            require(gate.config == *a[2].key && gate.timelock == v.timelock)?;
            let p = Project {
                timelock: v.timelock,
                config: *a[2].key,
                mint: *a[5].key,
                hook: *a[4].key,
                reserve_recipient: v.reserve_recipient,
                buyback: v.buyback,
                distribution: v.distribution,
                platform: *a[5].key == c.platform,
                ..Project::default()
            };
            create(
                program,
                &a[0],
                &a[3],
                &a[7],
                &[b"project", a[4].key.as_ref()],
                7,
                &p,
            )
        }
        2 => collect(program, a, args(data)?),
        3 => buy(program, a, args(data)?),
        // Receipt-shaped payouts remain available on PDA projects; tag 6 omits permanent receipts.
        4 => payout(program, a, args(data)?, true),
        5 => withdraw(program, a, args(data)?),
        6 => payout(program, a, args(data)?, false),
        _ => Err(ProgramError::InvalidInstructionData),
    }
}

fn collect(program: &Pubkey, a: &[AccountInfo], v: CollectArgs) -> Result<()> {
    require(a.len() >= 8 && !v.steps.is_empty() && v.steps.len() <= 2)?;
    let (c, mut p) = common(program, a, v.nonce)?;
    require(a[5].key == &p.mint)?;
    curve(&a[6], &p.mint, Some(&p.hook))?;
    let before = add(a[3].lamports(), wrapped(&a[7], &a[3])?)?;
    require(before >= p.reserved()?)?;
    let mut seen = Vec::new();
    for step in v.steps {
        let ix = instruction(&step, a)?;
        require(!seen.contains(&ix.program_id))?;
        seen.push(ix.program_id);
        if ix.program_id == PUMP {
            require(
                ix.data == [207, 17, 138, 242, 4, 34, 19, 56]
                    && ix.accounts.len() == 10
                    && key(&ix, 0)? == &p.hook
                    && key(&ix, 1)? == a[7].key
                    && key(&ix, 4)? == &NATIVE
                    && key(&ix, 5)? == &spl_token::ID,
            )?;
        } else {
            require(
                ix.program_id == AMM
                    && ix.data == [160, 57, 89, 42, 181, 139, 43, 66]
                    && ix.accounts.len() == 8
                    && key(&ix, 2)? == &p.hook
                    && key(&ix, 5)? == a[7].key
                    && key(&ix, 0)? == &NATIVE
                    && key(&ix, 1)? == &spl_token::ID,
            )?;
        }
        authorize(program, &p, |seeds| invoke_signed(&ix, a, &[seeds]))?;
    }
    let amount = sub(add(a[3].lamports(), wrapped(&a[7], &a[3])?)?, before)?;
    require(amount >= c.minimum)?;
    p.credit(amount, c.bounty_source)?;
    finish(program, a, &mut p, 0, amount, 0, 0)
}

fn buy(program: &Pubkey, a: &[AccountInfo], v: BuyArgs) -> Result<()> {
    require(a.len() >= 10 && v.kind <= 2 && !v.steps.is_empty() && v.steps.len() <= 4)?;
    let (c, mut p) = common(program, a, v.nonce)?;
    deadline(v.deadline)?;
    require(
        (if v.kind == 2 {
            p.distribution
        } else {
            p.buyback
        }) && !(v.kind == 1 && p.platform)
            && v.max_debit >= c.minimum
            && v.max_debit <= c.maximum
            && v.max_debit <= p.balances[v.kind as usize]
            && v.min_tokens > 0
            && v.sponsor_rent == 0,
    )?;
    let target = if v.kind == 1 { c.platform } else { p.mint };
    require(
        a[5].key == &target
            && a[6].key == &ata(&p.hook, &target, a[7].key)
            && a[7].key == a[5].owner,
    )?;
    mint(&a[5])?;
    curve(
        &a[9],
        &target,
        if v.kind == 1 { None } else { Some(&p.hook) },
    )?;
    let before_tokens = token(&a[6], &target, &p.hook, a[7].key)?;
    if v.kind != 1 {
        require(before_tokens >= p.reward_tokens)?;
    }
    let before = add(a[3].lamports(), wrapped(&a[8], &a[3])?)?;
    require(before >= p.reserved()?)?;
    transfer_sol(&a[0], &a[3], &a[4], v.sponsor_rent)?;
    let mut bought = false;
    for step in v.steps {
        let ix = instruction(&step, a)?;
        match ix.program_id {
            PUMP => {
                require(
                    !bought
                        && ix.data.len() == 24
                        && ix.data[..8] == [184, 23, 238, 97, 103, 197, 211, 61]
                        && key(&ix, 1)? == &target
                        && key(&ix, 2)? == &NATIVE
                        && key(&ix, 3)? == a[7].key
                        && key(&ix, 4)? == &spl_token::ID
                        && key(&ix, 10)? == a[9].key
                        && key(&ix, 13)? == &p.hook
                        && key(&ix, 14)? == a[6].key,
                )?;
                bought = true;
            }
            AMM => {
                let pool_creator =
                    Pubkey::find_program_address(&[b"pool-authority", target.as_ref()], &PUMP).0;
                let pool = Pubkey::find_program_address(
                    &[
                        b"pool",
                        &0u16.to_le_bytes(),
                        pool_creator.as_ref(),
                        target.as_ref(),
                        NATIVE.as_ref(),
                    ],
                    &AMM,
                )
                .0;
                require(
                    !bought
                        && (24..=26).contains(&ix.data.len())
                        && ix.data[..8] == [102, 6, 61, 18, 1, 218, 235, 234]
                        && key(&ix, 0)? == &pool
                        && key(&ix, 1)? == &p.hook
                        && key(&ix, 3)? == &target
                        && key(&ix, 4)? == &NATIVE
                        && key(&ix, 5)? == a[6].key
                        && key(&ix, 6)? == a[8].key
                        && key(&ix, 11)? == a[7].key
                        && key(&ix, 12)? == &spl_token::ID,
                )?;
                bought = true;
            }
            solana_program::system_program::ID => {
                require(
                    !bought
                        && ix.data.len() == 12
                        && ix.data[..4] == [2, 0, 0, 0]
                        && key(&ix, 0)? == &p.hook
                        && key(&ix, 1)? == a[8].key
                        && ix.accounts.len() == 2,
                )?;
                let amount = u64::from_le_bytes(ix.data[4..12].try_into().unwrap());
                require(amount <= v.max_debit)?;
            }
            spl_token::ID => require(
                !bought && ix.data == [17] && ix.accounts.len() == 1 && key(&ix, 0)? == a[8].key,
            )?,
            _ => return Err(ProgramError::IncorrectProgramId),
        }
        authorize(program, &p, |seeds| invoke_signed(&ix, a, &[seeds]))?;
    }
    require(bought)?;
    let received = sub(token(&a[6], &target, &p.hook, a[7].key)?, before_tokens)?;
    let after = add(a[3].lamports(), wrapped(&a[8], &a[3])?)?;
    let spent = sub(before, after)?;
    require(received >= v.min_tokens && spent > 0 && spent <= v.max_debit)?;
    let work = p.work()?;
    p.balances[v.kind as usize] = sub(p.balances[v.kind as usize], spent)?;
    p.spent = add(p.spent, spent)?;
    let reward = if v.kind == 2 {
        p.reward_tokens = add(p.reward_tokens, received)?;
        p.reward_cost = add(p.reward_cost, spent)?;
        0
    } else {
        authorize(program, &p, |seeds| {
            burn(&a[6], &a[5], &a[3], &a[7], received, seeds)
        })?;
        if v.kind == 0 {
            p.burned = add(p.burned, received)?;
        } else {
            p.platform_burned = add(p.platform_burned, received)?;
        }
        p.settle_work(spent, work)?
    };
    require(
        reward >= v.min_reward
            && a[3].lamports() >= reward
            && sub(after, reward)? >= p.reserved()?,
    )?;
    finish(program, a, &mut p, v.kind + 1, spent, received, reward)
}

fn payout(program: &Pubkey, a: &[AccountInfo], v: PayoutArgs, legacy_receipts: bool) -> Result<()> {
    let stride = if legacy_receipts { 3 } else { 2 };
    require(a.len() >= 8 + stride && (a.len() - 8) % stride == 0 && (a.len() - 8) / stride <= 4)?;
    let (c, mut p) = common(program, a, v.nonce)?;
    deadline(v.deadline)?;
    require(
        p.distribution
            && a[5].key == &p.mint
            && a[7].key == a[5].owner
            && a[6].key == &ata(&p.hook, &p.mint, a[7].key),
    )?;
    mint(&a[5])?;
    require(
        token(&a[6], &p.mint, &p.hook, a[7].key)? >= p.reward_tokens
            && a[3].lamports() >= p.reserved()?,
    )?;
    let count = ((a.len() - 8) / stride) as u64;
    let tokens = count * 10_000_000;
    require(tokens <= p.reward_tokens)?;
    let work = p.work()?;
    let cost = ratio(p.reward_cost, tokens, p.reward_tokens)?;
    for (index, chunk) in a[8..].chunks_exact(stride).enumerate() {
        let recipient = &chunk[0];
        let destination = &chunk[1];
        require(
            !a[8..8 + index * stride]
                .chunks_exact(stride)
                .any(|previous| previous[0].key == recipient.key),
        )?;
        wallet(recipient)?;
        require(
            ![
                p.hook,
                p.mint,
                c.platform,
                c.authority,
                p.reserve_recipient,
                *a[0].key,
            ]
            .contains(recipient.key)
                && destination.key == &ata(recipient.key, &p.mint, a[7].key),
        )?;
        token(destination, &p.mint, recipient.key, a[7].key)?;
        if legacy_receipts {
            create(
                program,
                &a[0],
                &chunk[2],
                &a[4],
                &[b"paid", a[2].key.as_ref(), recipient.key.as_ref()],
                3,
                &v.nonce,
            )?;
        }
        authorize(program, &p, |seeds| {
            transfer_tokens(&a[6], destination, &a[5], &a[3], &a[7], 10_000_000, seeds)
        })?;
    }
    p.reward_tokens = sub(p.reward_tokens, tokens)?;
    p.reward_cost = sub(p.reward_cost, cost)?;
    p.recipients_paid = add(p.recipients_paid, count)?;
    let reward = if cost == 0 {
        0
    } else {
        p.settle_work(cost, work)?
    };
    require(reward >= v.min_reward && sub(a[3].lamports(), reward)? >= p.reserved()?)?;
    finish(program, a, &mut p, 4, cost, tokens, reward)
}

fn withdraw(program: &Pubkey, a: &[AccountInfo], v: WithdrawArgs) -> Result<()> {
    require(a.len() == 6 && [3, 4].contains(&v.bucket) && v.amount > 0)?;
    let (c, mut p) = common(program, a, v.nonce)?;
    require(
        a[5].key
            == &(if v.bucket == 3 {
                p.reserve_recipient
            } else {
                c.authority
            })
            && a[3].lamports() >= p.reserved()?,
    )?;
    signer(&a[5])?;
    p.balances[v.bucket as usize] = sub(p.balances[v.bucket as usize], v.amount)?;
    p.spent = add(p.spent, v.amount)?;
    vault_transfer(program, &p, &a[3], &a[5], &a[4], v.amount)?;
    finish(program, a, &mut p, 5, v.amount, 0, 0)
}

fn authorize<T>(
    program: &Pubkey,
    p: &Project,
    action: impl FnOnce(&[&[u8]]) -> Result<T>,
) -> Result<T> {
    let seeds = [b"hook-vault".as_ref(), p.config.as_ref(), p.mint.as_ref()];
    let (address, bump) = Pubkey::find_program_address(&seeds, program);
    require(address == p.hook)?;
    action(&[seeds[0], seeds[1], seeds[2], &[bump]])
}
fn vault_transfer<'a>(
    program: &Pubkey,
    p: &Project,
    from: &AccountInfo<'a>,
    to: &AccountInfo<'a>,
    system: &AccountInfo<'a>,
    amount: u64,
) -> Result<()> {
    require(
        from.key == &p.hook
            && system.key == &solana_program::system_program::ID
            && from.key != to.key,
    )?;
    if amount == 0 {
        return Ok(());
    }
    authorize(program, p, |seeds| {
        invoke_signed(
            &system_instruction::transfer(from.key, to.key, amount),
            &[from.clone(), to.clone(), system.clone()],
            &[seeds],
        )
    })
}
// Keep the WSOL account's rent in that account; unwrapping never credits it as revenue.
fn unwrap<'a>(
    program: &Pubkey,
    p: &Project,
    core: &[AccountInfo<'a>],
    extra: &[AccountInfo<'a>],
) -> Result<()> {
    require(extra[2].key == &NATIVE && extra[3].key == &spl_token::ID && extra[4].key == &ATA)?;
    wrapped(&extra[1], &core[3])?;
    invoke_signed(
        &spl_token::instruction::sync_native(&spl_token::ID, extra[1].key)?,
        &[extra[1].clone(), extra[3].clone()],
        &[],
    )?;
    if wrapped(&extra[1], &core[3])? == 0 {
        return Ok(());
    }
    let infos = [
        core[3].clone(),
        extra[1].clone(),
        extra[2].clone(),
        core[4].clone(),
        extra[3].clone(),
        extra[4].clone(),
    ];
    authorize(program, p, |seeds| {
        invoke_signed(
            &spl_token::instruction::close_account(
                &spl_token::ID,
                extra[1].key,
                core[3].key,
                core[3].key,
                &[],
            )?,
            &infos,
            &[seeds],
        )?;
        invoke_signed(
            &Instruction {
                program_id: ATA,
                data: vec![1],
                accounts: vec![
                    AccountMeta::new(p.hook, true),
                    AccountMeta::new(*extra[1].key, false),
                    AccountMeta::new_readonly(p.hook, false),
                    AccountMeta::new_readonly(NATIVE, false),
                    AccountMeta::new_readonly(solana_program::system_program::ID, false),
                    AccountMeta::new_readonly(spl_token::ID, false),
                ],
            },
            &infos,
            &[seeds],
        )
    })
}
pub fn process(program: &Pubkey, a: &[AccountInfo], tag: u8, data: &[u8]) -> ProgramResult {
    if tag == 9 || tag == 10 {
        return manage_global(program, a, tag, data);
    }
    if tag == 7 || tag == 8 {
        return manage_plugins(program, a, tag, data);
    }
    if tag <= 1 {
        return process_inner(program, a, tag, data);
    }
    require((2..=6).contains(&tag) && a.len() >= 11 && data.len() >= 8)?;
    let (core, extra) = a.split_at(a.len() - 6);
    let nonce = u64::from_le_bytes(data[..8].try_into().unwrap());
    let (c, mut p) = common(program, core, nonce)?;
    require(extra[0].key == &c.authority)?;
    signer(&extra[0])?;
    let gate: PluginGate = load(program, &extra[5], 8)?;
    pda(program, &extra[5], &[b"plugins", p.config.as_ref()])?;
    require(gate.config == p.config && gate.timelock == p.timelock)?;
    let paused = p.paused | gate.paused;
    if tag == 3 {
        require(data.len() > 8 && paused & (if data[8] == 2 { 2 } else { 1 }) == 0)?;
    }
    if tag == 4 || tag == 6 {
        require(paused & 2 == 0)?;
    }
    unwrap(program, &p, core, extra)?;
    let available = sub(core[3].lamports(), Rent::get()?.minimum_balance(0))?;
    p.sync(available, c.bounty_source)?;
    save(&core[2], 7, &p)?;
    process_inner(program, core, tag, data)?;
    unwrap(program, &p, core, extra)?;
    let settled: Project = load(program, &core[2], 7)?;
    require(sub(core[3].lamports(), Rent::get()?.minimum_balance(0))? >= settled.reserved()?)
}

#[derive(BorshDeserialize, BorshSerialize)]
pub struct PluginChange {
    pub revision: u64,
    pub buyback: bool,
    pub distribution: bool,
    pub weights: [u16; 5],
    pub paused: u8,
}
fn manage_plugins(program: &Pubkey, a: &[AccountInfo], tag: u8, data: &[u8]) -> Result<()> {
    require(a.len() == if tag == 7 { 3 } else { 5 })?;
    signer(&a[0])?;
    let c: Config = load(program, &a[1], 1)?;
    pda(program, &a[1], &[b"config", c.authority.as_ref()])?;
    let mut p: Project = load(program, &a[2], 7)?;
    pda(program, &a[2], &[b"project", p.hook.as_ref()])?;
    require(p.config == *a[1].key)?;
    if tag == 7 {
        require(a[0].key == &c.authority && data.len() == 1 && data[0] > 0 && data[0] <= 3)?;
        p.paused |= data[0];
    } else {
        require(
            a[0].key
                == &Pubkey::find_program_address(&[b"upgrade", program.as_ref()], &p.timelock).0,
        )?;
        let v: PluginChange = args(data)?;
        require(
            v.revision == p.policy_revision
                && v.paused <= 3
                && v.weights.iter().map(|n| *n as u32).sum::<u32>()
                    == if c.bounty_source == 1 { 10000 } else { 9900 },
        )?;
        require(!p.platform || v.weights[1] == 0 && v.weights[3] == 0)?;
        // Settle funds already in the vault with the old allocation before changing it.
        require(
            a[3].key == &p.hook
                && a[3].owner == &solana_program::system_program::ID
                && a[3].data_is_empty(),
        )?;
        pda(
            program,
            &a[3],
            &[b"hook-vault", p.config.as_ref(), p.mint.as_ref()],
        )?;
        require(a[4].key == &ata(&p.hook, &NATIVE, &spl_token::ID))?;
        let wrapped_income = if a[4].data_is_empty() {
            require(a[4].owner == &solana_program::system_program::ID)?;
            a[4].lamports()
                .saturating_sub(Rent::get()?.minimum_balance(spl_token::state::Account::LEN))
        } else {
            wrapped(&a[4], &a[3])?;
            let native = spl_token::state::Account::unpack(&a[4].try_borrow_data()?)?.is_native;
            sub(
                a[4].lamports(),
                native.ok_or(ProgramError::InvalidAccountData)?,
            )?
        };
        p.sync(
            add(
                sub(a[3].lamports(), Rent::get()?.minimum_balance(0))?,
                wrapped_income,
            )?,
            c.bounty_source,
        )?;
        p.buyback = v.buyback;
        p.distribution = v.distribution;
        p.weights = v.weights;
        p.paused = v.paused;
    }
    p.policy_revision = add(p.policy_revision, 1)?;
    p.nonce = add(p.nonce, 1)?;
    p.conserve()?;
    save(&a[2], 7, &p)
}

fn manage_global(program: &Pubkey, a: &[AccountInfo], tag: u8, data: &[u8]) -> Result<()> {
    require(a.len() == 3)?;
    signer(&a[0])?;
    let c: Config = load(program, &a[1], 1)?;
    pda(program, &a[1], &[b"config", c.authority.as_ref()])?;
    let mut gate: PluginGate = load(program, &a[2], 8)?;
    pda(program, &a[2], &[b"plugins", a[1].key.as_ref()])?;
    require(gate.config == *a[1].key)?;
    if tag == 9 {
        require(a[0].key == &c.authority && data.len() == 1 && data[0] > 0 && data[0] <= 3)?;
        gate.paused |= data[0];
    } else {
        require(
            a[0].key
                == &Pubkey::find_program_address(&[b"upgrade", program.as_ref()], &gate.timelock).0
                && data.len() == 9
                && u64::from_le_bytes(data[..8].try_into().unwrap()) == gate.revision
                && data[8] > 0
                && data[8] <= 3,
        )?;
        gate.paused &= !data[8];
    }
    gate.revision = add(gate.revision, 1)?;
    save(&a[2], 8, &gate)
}
