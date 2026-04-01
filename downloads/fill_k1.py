import pypdf
import copy

BASE = r'C:\Users\Footb\Documents\Github\teleclaude-main\downloads'

def fill_k1(partner_data, output_filename):
    """Fill a Schedule K-1 for one partner."""
    reader = pypdf.PdfReader(f'{BASE}\\f1065sk1.pdf')
    writer = pypdf.PdfWriter()
    writer.append(reader)

    # K-1 field mapping based on field analysis:
    # Page header:
    # f1_1 through f1_5 = Calendar year / tax year fields
    # LeftCol = Part I (Partnership info) + Part II (Partner info) + Part II details
    # RightCol = Part III (Partner's Share of Current Year Income)

    # Part I - Information About the Partnership
    # f1_6 = Partnership EIN
    # f1_7 = Partnership name
    # f1_8 = Partnership street address
    # f1_9 = Partnership city/state/zip
    # f1_10 = IRS Center where return filed

    # Part II - Information About the Partner
    # f1_11 = Partner SSN (LEAVE BLANK)
    # f1_12 = Partner name
    # f1_13 = Partner street address (or leave blank for Billy)

    # Checkboxes in Part II:
    # c1_3 = General partner or LLC member-manager
    # c1_4[0] = Limited partner, c1_4[1] = LLC member (not manager?)
    # c1_5[0] = Domestic partner, c1_5[1] = Foreign partner
    # c1_6 = Entity type - Individual
    # c1_7 = Disregarded entity?
    # c1_8[0] = retirement plan, c1_8[1] = ?

    # Line J (Profit/Loss/Capital percentages):
    # Profit: f1_14 = beginning, f1_15 = ending
    # Loss: f1_16 = beginning, f1_17 = ending
    # Capital: f1_18 = beginning, f1_19 = ending

    # Line K1 (Liabilities):
    # Nonrecourse: f1_20 = beginning, f1_21 = ending
    # Qualified nonrecourse: f1_22 = beginning, f1_23 = ending
    # Recourse: f1_24 = beginning, f1_25 = ending
    # c1_9 = check if basis computed
    # c1_10 = check if alternate

    # Line L (Capital account analysis):
    # f1_26 = Beginning capital account
    # f1_27 = Capital contributed during year
    # f1_28 = Current year increase (decrease)
    # f1_29 = Withdrawals & distributions
    # f1_30 = Ending capital account
    # f1_31 = ? (maybe another L line)
    # c1_11[0] = Tax basis, c1_11[1] = GAAP, etc.

    # Line N: f1_32 = Partner's share of net unrecognized sec 704(c) gain/loss beginning
    #          f1_33 = ending

    # RIGHT COLUMN - Part III
    # f1_34 = Line 1 (Ordinary business income/loss)
    # f1_35 = Line 2 (Net rental real estate income)
    # f1_36 = Line 3 (Other net rental income)
    # f1_37 = Line 4a (Guaranteed payments for services)
    # f1_38 = Line 4b (Guaranteed payments for capital)
    # f1_39 = Line 4c (Total guaranteed payments)
    # f1_40 = Line 5 (Interest income)
    # f1_41 = Line 6a (Ordinary dividends)
    # f1_42 = Line 6b (Qualified dividends)
    # f1_43 = Line 7 (Royalties)
    # f1_44 = Line 8 (Net short-term capital gain/loss)
    # f1_45 = Line 9a (Net long-term capital gain/loss)
    # f1_46 = Line 9b (Collectibles gain/loss)
    # f1_47 = Line 9c (Unrecaptured section 1250 gain)
    # f1_48 = Line 10 (Net section 1231 gain/loss)
    # f1_49 = Line 11 (Other income/loss)

    # Lines in RightCol2:
    # Line13 = Line 13 (?)
    # f1_50 through f1_59 = various other lines
    # Then Line14-Line20 and more fields

    prefix = "topmostSubform[0].Page1[0]"

    fields = {
        # Header - calendar year
        f"{prefix}.Pg1Header[0].ForCalendarYear[0].f1_1[0]": "2025",

        # Part I - Partnership Info
        f"{prefix}.LeftCol[0].f1_6[0]": partner_data['partnership_ein'],
        f"{prefix}.LeftCol[0].f1_7[0]": partner_data['partnership_name'],
        f"{prefix}.LeftCol[0].f1_8[0]": partner_data['partnership_address'],
        f"{prefix}.LeftCol[0].f1_9[0]": partner_data['partnership_city_state_zip'],
        f"{prefix}.LeftCol[0].f1_10[0]": partner_data['irs_center'],

        # Part II - Partner Info
        # f1_11 = Partner SSN - leave blank
        f"{prefix}.LeftCol[0].f1_12[0]": partner_data['partner_name'],
        f"{prefix}.LeftCol[0].f1_13[0]": partner_data.get('partner_address', ''),

        # Checkboxes
        f"{prefix}.LeftCol[0].c1_3[0]": "/1",  # General partner / LLC member-manager
        f"{prefix}.LeftCol[0].c1_5[0]": "/1",  # Domestic partner
        f"{prefix}.LeftCol[0].c1_6[0]": "/1",  # Individual

        # Line J - Profit/Loss/Capital percentages
        f"{prefix}.LeftCol[0].LineJTable[0].Profit[0].f1_14[0]": partner_data['pct'],
        f"{prefix}.LeftCol[0].LineJTable[0].Profit[0].f1_15[0]": partner_data['pct'],
        f"{prefix}.LeftCol[0].LineJTable[0].Loss[0].f1_16[0]": partner_data['pct'],
        f"{prefix}.LeftCol[0].LineJTable[0].Loss[0].f1_17[0]": partner_data['pct'],
        f"{prefix}.LeftCol[0].LineJTable[0].Capital[0].f1_18[0]": partner_data['pct'],
        f"{prefix}.LeftCol[0].LineJTable[0].Capital[0].f1_19[0]": partner_data['pct'],

        # Line K1 - Liabilities (all $0)
        f"{prefix}.LeftCol[0].LineK1Table[0].LineK1Table[0].Nonrecourse[0].f1_20[0]": "0",
        f"{prefix}.LeftCol[0].LineK1Table[0].LineK1Table[0].Nonrecourse[0].f1_21[0]": "0",
        f"{prefix}.LeftCol[0].LineK1Table[0].LineK1Table[0].QualifiedNonrecourse[0].f1_22[0]": "0",
        f"{prefix}.LeftCol[0].LineK1Table[0].LineK1Table[0].QualifiedNonrecourse[0].f1_23[0]": "0",
        f"{prefix}.LeftCol[0].LineK1Table[0].LineK1Table[0].Recourse[0].f1_24[0]": "0",
        f"{prefix}.LeftCol[0].LineK1Table[0].LineK1Table[0].Recourse[0].f1_25[0]": "0",

        # Line L - Capital Account Analysis
        f"{prefix}.LeftCol[0].LIneLTable[0].LineLTable[0].Row1[0].f1_26[0]": "0",  # Beginning
        f"{prefix}.LeftCol[0].LIneLTable[0].LineLTable[0].Row2[0].f1_27[0]": partner_data['contributions'],  # Contributions
        f"{prefix}.LeftCol[0].LIneLTable[0].LineLTable[0].Row3[0].f1_28[0]": partner_data['current_year_loss'],  # Current year increase (decrease)
        f"{prefix}.LeftCol[0].LIneLTable[0].LineLTable[0].Row4[0].f1_29[0]": "0",  # Withdrawals
        f"{prefix}.LeftCol[0].LIneLTable[0].LineLTable[0].Row5[0].f1_30[0]": "0",  # Ending

        # Tax basis checkbox
        f"{prefix}.LeftCol[0].c1_11[0]": "/1",  # Tax basis

        # Part III - Partner's Share of Current Year Income
        f"{prefix}.RightCol[0].RightCol1[0].f1_34[0]": partner_data['line1'],  # Line 1 Ordinary business income
        f"{prefix}.RightCol[0].RightCol1[0].f1_35[0]": "0",  # Line 2
        f"{prefix}.RightCol[0].RightCol1[0].f1_36[0]": "0",  # Line 3
        f"{prefix}.RightCol[0].RightCol1[0].f1_37[0]": "0",  # Line 4a
        f"{prefix}.RightCol[0].RightCol1[0].f1_38[0]": "0",  # Line 4b
        f"{prefix}.RightCol[0].RightCol1[0].f1_39[0]": "0",  # Line 4c
        f"{prefix}.RightCol[0].RightCol1[0].f1_40[0]": "0",  # Line 5
        f"{prefix}.RightCol[0].RightCol1[0].f1_41[0]": "0",  # Line 6a
        f"{prefix}.RightCol[0].RightCol1[0].f1_42[0]": "0",  # Line 6b
        f"{prefix}.RightCol[0].RightCol1[0].f1_43[0]": "0",  # Line 7
        f"{prefix}.RightCol[0].RightCol1[0].f1_44[0]": "0",  # Line 8
        f"{prefix}.RightCol[0].RightCol1[0].f1_45[0]": "0",  # Line 9a
        f"{prefix}.RightCol[0].RightCol1[0].f1_46[0]": "0",  # Line 9b
        f"{prefix}.RightCol[0].RightCol1[0].f1_47[0]": "0",  # Line 9c
        f"{prefix}.RightCol[0].RightCol1[0].f1_48[0]": "0",  # Line 10
        f"{prefix}.RightCol[0].RightCol1[0].f1_49[0]": "0",  # Line 11
        # Line 12 (Section 179 deduction) - skip
        f"{prefix}.RightCol[0].RightCol1[0].Line13[0]": "0",  # Line 13
    }

    writer.update_page_form_field_values(writer.pages[0], fields)

    output_path = f'{BASE}\\{output_filename}'
    writer.write(output_path)
    print(f"K-1 saved to {output_path}")

    # Verify
    reader2 = pypdf.PdfReader(output_path)
    fields2 = reader2.get_fields()
    key = f"{prefix}.RightCol[0].RightCol1[0].f1_34[0]"
    f = fields2.get(key, {})
    val = f.get('/V', 'NOT SET') if isinstance(f, dict) else 'NOT SET'
    print(f"  Partner: {partner_data['partner_name']}")
    print(f"  Line 1 (Ordinary income): {val}")
    key2 = f"{prefix}.LeftCol[0].f1_6[0]"
    f2 = fields2.get(key2, {})
    val2 = f2.get('/V', 'NOT SET') if isinstance(f2, dict) else 'NOT SET'
    print(f"  Partnership EIN: {val2}")


# K-1 #1 - Nicholas Joel Liautaud
nick_data = {
    'partnership_ein': '39-2788370',
    'partnership_name': 'SOLUVO',
    'partnership_address': '17606 79TH CT N',
    'partnership_city_state_zip': 'LOXAHATCHEE, FL 33470',
    'irs_center': 'Ogden, UT',
    'partner_name': 'NICHOLAS JOEL LIAUTAUD',
    'partner_address': '17606 79TH CT N, LOXAHATCHEE, FL 33470',
    'pct': '64.5%',
    'contributions': '796',
    'current_year_loss': '(796)',
    'line1': '(796)',
}

fill_k1(nick_data, 'SOLUVO_K1_Nick_2025_filled.pdf')

# K-1 #2 - William Swann
billy_data = {
    'partnership_ein': '39-2788370',
    'partnership_name': 'SOLUVO',
    'partnership_address': '17606 79TH CT N',
    'partnership_city_state_zip': 'LOXAHATCHEE, FL 33470',
    'irs_center': 'Ogden, UT',
    'partner_name': 'WILLIAM SWANN',
    'partner_address': '',  # Leave blank - partner fills in
    'pct': '35.5%',
    'contributions': '438',
    'current_year_loss': '(438)',
    'line1': '(438)',
}

fill_k1(billy_data, 'SOLUVO_K1_Billy_2025_filled.pdf')
