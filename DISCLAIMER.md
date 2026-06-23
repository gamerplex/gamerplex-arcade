# DISCLAIMER

**This repository contains software, not financial or gambling infrastructure.**

The `gamerplex-arcade` Anchor program implements a **single-player skill-arcade microtransaction** product: a player pays a flat, fixed fee per action (e.g. saving a score, verifying a replay, or minting a receipt of a score) on a public blockchain. Publication of source code is for transparency, code review, and integration testing.

## What this is — and is not

- **It is** a pay-per-action digital service, in the same category as an arcade machine, Pac-Man, chess.com puzzles, or Skillz-style skill contests: you pay a fixed fee for a service (recording or verifying a result), not a stake on an outcome.
- **It is not** gambling, a wager, a bet, a lottery, or a game of chance. There is **no pot, no prize pool, no rake, and no payout determined by the result of a match.** The fee is the same regardless of the player's score.

## Skill, not chance

Scores are the **deterministic result of player skill** in the underlying game. Leaderboards are informational rankings of those scores. No outcome in this program is determined by chance, by an oracle, or by server-side judgment.

## Operator

Gamerplex Pty Ltd (Australia) develops **and operates** the single-player skill-arcade microtransaction product against this program. The operator is responsible for its terms of service, geofencing, and compliance controls.

This is a **separate product and entity** from any wagered head-to-head ("Battle") or pari-mutuel skill-contest surface. Those wagered surfaces are operated by a separate entity at contention.markets and are **not** operated by Gamerplex Pty Ltd. Nothing in this repository is an offer of a wagered or pooled-funds product.

## No pooled-funds custody

Each microtransaction is a one-way payment for a service rendered. The program does **not** hold user balances, does not custody pooled funds awaiting settlement, and does not pay out based on any contest result.

## $GAME token is not an investment

Any token referenced by this product (including `$GAME`) is a **consumable utility credit** for accessing features. It is **not an investment, security, or ownership stake**, and confers no profit expectation, dividend, or governance right. The canonical `$GAME` mint is `7TTBUfDomCKBMemv7FF37Tg3y52cRkAxn8vJnvKD4rsE`; tokens at any other address are not affiliated with this product.

## No warranty

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

## Operator responsibility

The MIT license grants source rights only. Any party that forks, deploys, integrates, or operates this code is **solely responsible** for:

- Determining the legal status of their service in every jurisdiction they serve
- Obtaining any required licenses, registrations, or approvals
- Implementing geofencing, identity/age verification, and any other applicable controls
- Maintaining the security of any keys, multisigs, or infrastructure they deploy
- Any taxes, fees, or other obligations owed to any government or counterparty

If you do not understand the legal implications of operating a paid on-chain product in your jurisdiction, **do not deploy this code as a user-facing service.** Consult competent counsel.

## No financial advice

Nothing in this repository constitutes financial, investment, legal, tax, or other professional advice. The fee and token descriptions describe how the software behaves, not whether any participant should use it.

## Trademark

"Gamerplex", the Gamerplex wordmark, and related logos are property of Gamerplex Pty Ltd. The MIT license covers the source code only and grants no trademark rights.

## Contact

Security: `security@gamerplex.com`
General: see [`README.md`](./README.md)
