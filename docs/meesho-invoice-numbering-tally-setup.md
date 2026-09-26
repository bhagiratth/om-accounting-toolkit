# Meesho Sales Invoice Numbering — Tally Setup (Zikr India)

**Goal:** 1-Aug-2026 se Zikr India company mein Meesho ke Sales invoices ki numbering
naye series mein chahiye — `MeeshoA-1`, `MeeshoA-2`, `MeeshoA-3` ... aage isi tarah badhte hue.

Purane invoices (1-Aug-2026 se pehle wale) apni current numbering mein hi rahenge —
kuch change nahi hoga. Sirf 1-Aug-2026 se naya prefix aur naya start (1 se) lagu hoga.

Yeh Tally Prime ke **"Restart Numbering"** feature se hota hai, jo ek hi Voucher Type
ke andar date-wise alag-alag numbering series allow karta hai.

## Prerequisite

Meesho ke sales invoices pehle se ek dedicated Voucher Type — **`Sales Meesho`** — se
bante hain. Isliye naya voucher type banane ki zaroorat nahi hai; seedha isi voucher
type ko **Alter** karke numbering add karni hai.

## Step 1 — Company select karo

Gateway of Tally mein **Zikr India** company open/select karo (F1 se company change
kar sakte ho agar khuli nahi hai).

## Step 2 — Voucher Type Alter karo

1. `Gateway of Tally → Alter → Voucher Type` (ya path: Masters → Voucher Types → Alter)
2. Select karo: **Sales Meesho**
3. `Use Advance Configuration` ko **Yes** karo (agar pehle se Yes nahi hai)

## Step 3 — Voucher Numbering configure karo

Voucher Type alteration screen mein neeche numbering ka section hota hai:

1. **Method of Numbering**: `Automatic`
2. **Prevent Duplicates**: `Yes`
3. Numbering table mein ek **naya row/period** add karo:

   | Applicable From | Particulars (Prefix) | Starting Number |
   |---|---|---|
   | (existing/current period rows jaisa hai waisa hi rehne do) | | |
   | **1-8-2026** | **MeeshoA-** | **1** |

   - `Applicable From` mein date daalo: `1-Aug-2026`
   - `Particulars` / Prefix field mein: `MeeshoA-`
   - `Starting Number`: `1`
   - Suffix khaali rakho (jab tak `MeeshoA-1`, `MeeshoA-2` format hi chahiye, kisi
     suffix ki zaroorat nahi).

4. Tally khud is naye row ko **1-Aug-2026 se effective** treat karega — us date se
   pehle bane vouchers apni purani numbering mein hi dikhenge, aur us din se banne
   wale naye Meesho sales vouchers `MeeshoA-1` se shuru honge.

## Step 4 — Save

`Ctrl+A` dabakar save karo.

## Step 5 — Verify

1-Aug-2026 (ya uske baad ki) date daalkar is voucher type mein ek test/trial Sales
entry banao aur check karo ki number `MeeshoA-1` aa raha hai. Confirm hone ke baad
entry delete/cancel kar do taaki test entry se numbering na badhe.

## Notes

- Agar aage kisi financial year mein numbering fir se restart karni ho (e.g. naye FY
  mein `MeeshoA-1` se dobara), to isi table mein ek aur row add kar sakte ho — jitni
  chaho utni date-wise series ek hi voucher type ke andar rakh sakte ho.
- Yeh setting company-specific hai — agar Zikr India ke alawa kisi aur company mein
  bhi yehi Meesho numbering chahiye, to wahan bhi yeh steps alag se repeat karne
  honge.
