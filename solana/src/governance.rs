use crate::{accounts::*, state::*};
use borsh::{BorshDeserialize, BorshSerialize};
use solana_program::{
    account_info::AccountInfo, clock::Clock, entrypoint::ProgramResult,
    program_error::ProgramError, pubkey::Pubkey, sysvar::Sysvar,
};

pub const DAY: i64 = 86_400;
#[derive(BorshDeserialize, BorshSerialize, Debug)]
pub struct InitArgs {
    pub team: Pubkey,
    pub release_basis: u8,
    pub quorum: u64,
    pub weight_cap_seconds: u32,
}
#[derive(BorshDeserialize, BorshSerialize, Debug)]
pub struct VoteArgs {
    pub amount: u64,
    pub support: bool,
}
fn args<T: BorshDeserialize>(data: &[u8]) -> Result<T> {
    T::try_from_slice(data).map_err(|_| ProgramError::InvalidInstructionData)
}
fn governance(program: &Pubkey, account: &AccountInfo) -> Result<(Governance, u8)> {
    let g: Governance = load(program, account, 16)?;
    let bump = pda(program, account, &[b"dao", g.config.as_ref()])?;
    Ok((g, bump))
}
fn round(program: &Pubkey, account: &AccountInfo, governance: &Pubkey) -> Result<(Round, u8)> {
    let r: Round = load(program, account, 17)?;
    require(r.governance == *governance)?;
    let bump = pda(
        program,
        account,
        &[b"round", governance.as_ref(), &r.number.to_le_bytes()],
    )?;
    Ok((r, bump))
}
fn vault(account: &AccountInfo, owner: &Pubkey, g: &Governance) -> Result<u64> {
    require(account.key == &ata(owner, &g.mint, &g.token_program))?;
    token(account, &g.mint, owner, &g.token_program)
}
fn asset(g: &Governance, token: &AccountInfo, program: &AccountInfo) -> Result<()> {
    require(
        token.key == &g.mint && token.owner == &g.token_program && program.key == &g.token_program,
    )?;
    mint(token)?;
    Ok(())
}

pub fn process(program: &Pubkey, a: &[AccountInfo], tag: u8, data: &[u8]) -> ProgramResult {
    match tag {
        16 => initialize(program, a, args(data)?),
        17 if data.is_empty() => open(program, a),
        18 => vote(program, a, args(data)?),
        19 if data.is_empty() => settle(program, a),
        20 if data.is_empty() => withdraw(program, a),
        _ => Err(ProgramError::InvalidInstructionData),
    }
}

// The funding wallet supplies bought Pump tokens; this program never mints an allocation.
fn initialize(program: &Pubkey, a: &[AccountInfo], v: InitArgs) -> Result<()> {
    require(a.len() == 9)?;
    signer(&a[0])?;
    wallet(&a[0])?;
    let c: Config = load(program, &a[1], 1)?;
    pda(program, &a[1], &[b"config", c.authority.as_ref()])?;
    require(
        c.authority == *a[0].key
            && a[3].key == &c.platform
            && a[6].key == a[3].owner
            && signing_address(&v.team)
            && v.team != c.platform
            && v.release_basis <= 1
            && v.weight_cap_seconds > 0
            && v.weight_cap_seconds <= DAY as u32,
    )?;
    let m = mint(&a[3])?;
    require(
        m.supply > 0
            && m.supply <= 1_000_000_000_000_000
            && m.mint_authority.is_none()
            && v.quorum > 0
            && v.quorum <= m.supply,
    )?;
    let initial_supply = curve(&a[7], a[3].key, None)?;
    require(initial_supply <= 1_000_000_000_000_000 && m.supply <= initial_supply)?;
    let amount = ratio(initial_supply, 30, 100)?;
    require(amount > 0 && token(&a[4], a[3].key, a[0].key, a[6].key)? >= amount)?;
    let g = Governance {
        config: *a[1].key,
        mint: *a[3].key,
        team: v.team,
        token_program: *a[6].key,
        initial: amount,
        remaining: amount,
        genesis: Clock::get()?.unix_timestamp,
        release_basis: v.release_basis,
        quorum: v.quorum,
        weight_cap_seconds: v.weight_cap_seconds,
        next_round: 0,
        active: false,
    };
    // Unsolicited deposits must not prevent initialization or inflate the recorded lock.
    vault(&a[5], a[2].key, &g)?;
    create(
        program,
        &a[0],
        &a[2],
        &a[8],
        &[b"dao", a[1].key.as_ref()],
        16,
        &g,
    )?;
    transfer_tokens(&a[4], &a[5], &a[3], &a[0], &a[6], amount, &[])
}

fn open(program: &Pubkey, a: &[AccountInfo]) -> Result<()> {
    require(a.len() == 8)?;
    signer(&a[0])?;
    let (mut g, bump) = governance(program, &a[1])?;
    asset(&g, &a[5], &a[6])?;
    let now = Clock::get()?.unix_timestamp;
    require(now >= g.genesis && !g.active && g.remaining > 0)?;
    let number = ((now - g.genesis) / DAY) as u64;
    require(number >= g.next_round && vault(&a[3], a[1].key, &g)? >= g.remaining)?;
    vault(&a[4], a[2].key, &g)?;
    let base = if g.release_basis == 0 {
        g.initial
    } else {
        g.remaining
    };
    let pot = (base / 1000).max(1).min(g.remaining);
    let end = g
        .genesis
        .checked_add(
            i64::try_from(number + 1)
                .map_err(|_| ProgramError::ArithmeticOverflow)?
                .checked_mul(DAY)
                .ok_or(ProgramError::ArithmeticOverflow)?,
        )
        .ok_or(ProgramError::ArithmeticOverflow)?;
    let r = Round {
        governance: *a[1].key,
        number,
        end,
        pot,
        ..Round::default()
    };
    create(
        program,
        &a[0],
        &a[2],
        &a[7],
        &[b"round", a[1].key.as_ref(), &number.to_le_bytes()],
        17,
        &r,
    )?;
    transfer_tokens(
        &a[3],
        &a[4],
        &a[5],
        &a[1],
        &a[6],
        pot,
        &[b"dao", g.config.as_ref(), &[bump]],
    )?;
    g.remaining = sub(g.remaining, pot)?;
    g.next_round = add(number, 1)?;
    g.active = true;
    save(&a[1], 16, &g)
}

fn vote(program: &Pubkey, a: &[AccountInfo], v: VoteArgs) -> Result<()> {
    require(a.len() == 9 && v.amount > 0)?;
    signer(&a[0])?;
    let (g, _) = governance(program, &a[1])?;
    let (mut r, _) = round(program, &a[2], a[1].key)?;
    asset(&g, &a[6], &a[7])?;
    let now = Clock::get()?.unix_timestamp;
    require(
        g.active
            && add(r.number, 1)? == g.next_round
            && r.outcome == 0
            && now < r.end
            && now >= r.end - DAY,
    )?;
    vault(&a[5], a[2].key, &g)?;
    token(&a[4], &g.mint, a[0].key, &g.token_program)?;
    let seeds = [b"vote".as_ref(), a[2].key.as_ref(), a[0].key.as_ref()];
    pda(program, &a[3], &seeds)?;
    let mut p = if a[3].data_is_empty() {
        let p = Vote {
            round: *a[2].key,
            voter: *a[0].key,
            support: v.support,
            ..Vote::default()
        };
        create(program, &a[0], &a[3], &a[8], &seeds, 18, &p)?;
        p
    } else {
        load::<Vote>(program, &a[3], 18)?
    };
    require(
        p.round == *a[2].key && p.voter == *a[0].key && p.support == v.support && !p.withdrawn,
    )?;
    let weight =
        (v.amount as u128) * ((r.end - now) as u64).min(g.weight_cap_seconds as u64) as u128;
    p.stake = add(p.stake, v.amount)?;
    p.weight = p
        .weight
        .checked_add(weight)
        .ok_or(ProgramError::ArithmeticOverflow)?;
    if v.support {
        r.yes = r
            .yes
            .checked_add(weight)
            .ok_or(ProgramError::ArithmeticOverflow)?;
        r.yes_stake = add(r.yes_stake, v.amount)?;
    } else {
        r.no =
            r.no.checked_add(weight)
                .ok_or(ProgramError::ArithmeticOverflow)?;
        r.no_stake = add(r.no_stake, v.amount)?;
    }
    transfer_tokens(&a[4], &a[5], &a[6], &a[0], &a[7], v.amount, &[])?;
    save(&a[2], 17, &r)?;
    save(&a[3], 18, &p)
}

fn settle(program: &Pubkey, a: &[AccountInfo]) -> Result<()> {
    require(a.len() == 7)?;
    let (mut g, _) = governance(program, &a[0])?;
    let (mut r, bump) = round(program, &a[1], a[0].key)?;
    asset(&g, &a[5], &a[6])?;
    require(
        g.active
            && add(r.number, 1)? == g.next_round
            && r.outcome == 0
            && Clock::get()?.unix_timestamp >= r.end,
    )?;
    require(
        vault(&a[2], a[0].key, &g)? >= g.remaining
            && vault(&a[3], a[1].key, &g)? >= add(r.pot, add(r.yes_stake, r.no_stake)?)?,
    )?;
    require(a[4].key == &ata(&g.team, &g.mint, &g.token_program))?;
    token(&a[4], &g.mint, &g.team, &g.token_program)?;
    let seeds: &[&[u8]] = &[
        b"round",
        a[0].key.as_ref(),
        &r.number.to_le_bytes(),
        &[bump],
    ];
    let weight = r
        .yes
        .checked_add(r.no)
        .ok_or(ProgramError::ArithmeticOverflow)?;
    let quorum = add(r.yes_stake, r.no_stake)? >= g.quorum
        && weight >= (g.quorum as u128) * g.weight_cap_seconds as u128 / 2;
    if !quorum || r.yes == r.no {
        r.outcome = 3;
        transfer_tokens(&a[3], &a[2], &a[5], &a[1], &a[6], r.pot, seeds)?;
        g.remaining = add(g.remaining, r.pot)?;
    } else {
        let share = ratio(r.pot, 90, 100)?;
        r.outcome = if r.yes > r.no { 1 } else { 2 };
        r.reward_remaining = sub(r.pot, share)?;
        r.weight_remaining = if r.outcome == 1 { r.yes } else { r.no };
        if r.outcome == 1 {
            transfer_tokens(&a[3], &a[4], &a[5], &a[1], &a[6], share, seeds)?;
        } else if share > 0 {
            burn(&a[3], &a[5], &a[1], &a[6], share, seeds)?;
        }
    }
    g.active = false;
    save(&a[0], 16, &g)?;
    save(&a[1], 17, &r)?;
    solana_program::log::sol_log_data(&[
        b"SingleSparkRoundV1",
        a[0].key.as_ref(),
        &r.number.to_le_bytes(),
        &[r.outcome],
        &r.pot.to_le_bytes(),
    ]);
    Ok(())
}

fn withdraw(program: &Pubkey, a: &[AccountInfo]) -> Result<()> {
    require(a.len() == 8)?;
    signer(&a[0])?;
    let (g, _) = governance(program, &a[1])?;
    let (mut r, bump) = round(program, &a[2], a[1].key)?;
    let mut p: Vote = load(program, &a[3], 18)?;
    pda(
        program,
        &a[3],
        &[b"vote", a[2].key.as_ref(), a[0].key.as_ref()],
    )?;
    asset(&g, &a[6], &a[7])?;
    require(
        r.outcome != 0
            && p.round == *a[2].key
            && p.voter == *a[0].key
            && !p.withdrawn
            && p.stake > 0,
    )?;
    vault(&a[4], a[2].key, &g)?;
    require(a[5].key == &ata(a[0].key, &g.mint, &g.token_program))?;
    token(&a[5], &g.mint, a[0].key, &g.token_program)?;
    let reward = if (r.outcome == 1 && p.support) || (r.outcome == 2 && !p.support) {
        require(p.weight <= r.weight_remaining)?;
        let total = if p.support { r.yes } else { r.no };
        let pot = sub(r.pot, ratio(r.pot, 90, 100)?)?;
        let reward = if p.weight == r.weight_remaining {
            r.reward_remaining
        } else {
            u64::try_from(
                (pot as u128)
                    .checked_mul(p.weight)
                    .ok_or(ProgramError::ArithmeticOverflow)?
                    / total,
            )
            .map_err(|_| ProgramError::ArithmeticOverflow)?
        };
        r.reward_remaining = sub(r.reward_remaining, reward)?;
        r.weight_remaining -= p.weight;
        reward
    } else {
        0
    };
    transfer_tokens(
        &a[4],
        &a[5],
        &a[6],
        &a[2],
        &a[7],
        add(p.stake, reward)?,
        &[
            b"round",
            a[1].key.as_ref(),
            &r.number.to_le_bytes(),
            &[bump],
        ],
    )?;
    p.withdrawn = true;
    save(&a[2], 17, &r)?;
    save(&a[3], 18, &p)
}
