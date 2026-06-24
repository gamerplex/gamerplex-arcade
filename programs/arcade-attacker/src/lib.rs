// Test-only program. Its single instruction CPIs an arbitrary instruction into
// the arcade program, forwarding remaining_accounts — used by the localnet
// suite to prove record_payment rejects CPI invocation (RA-A).
use anchor_lang::prelude::*;
use anchor_lang::solana_program::{
    instruction::{AccountMeta, Instruction},
    program::invoke,
};

declare_id!("ERTfswRtbajRGZsrpAJuJApfsVTnVJtKPobQD7JaB4M4");

#[program]
pub mod arcade_attacker {
    use super::*;

    pub fn cpi_record_payment(ctx: Context<CpiRecordPayment>, data: Vec<u8>) -> Result<()> {
        let metas: Vec<AccountMeta> = ctx
            .remaining_accounts
            .iter()
            .map(|a| AccountMeta {
                pubkey: *a.key,
                is_signer: a.is_signer,
                is_writable: a.is_writable,
            })
            .collect();
        let ix = Instruction {
            program_id: ctx.accounts.arcade_program.key(),
            accounts: metas,
            data,
        };
        invoke(&ix, ctx.remaining_accounts)?;
        Ok(())
    }
}

#[derive(Accounts)]
pub struct CpiRecordPayment<'info> {
    /// CHECK: target arcade program; validated by the CPI itself.
    pub arcade_program: AccountInfo<'info>,
}
