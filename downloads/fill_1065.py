import pypdf

BASE = r'C:\Users\Footb\Documents\Github\teleclaude-main\downloads'

reader = pypdf.PdfReader(f'{BASE}\\f1065.pdf')
writer = pypdf.PdfWriter()
writer.append(reader)

def p1(f):
    return f"topmostSubform[0].Page1[0].HeaderAddress_ReadOrder[0].CalendarName_ReadOrder[0].{f}"

def p1a(f):
    return f"topmostSubform[0].Page1[0].LinesA-C[0].{f}"

def p1f(f):
    return f"topmostSubform[0].Page1[0].{f}"

# PAGE 1
page1_fields = {
    # Name and address
    p1("f1_04[0]"): "SOLUVO",
    p1("f1_05[0]"): "17606 79TH CT N",
    p1("f1_06[0]"): "",
    p1("f1_07[0]"): "LOXAHATCHEE",
    p1("f1_08[0]"): "FL",
    p1("f1_09[0]"): "33470",

    # Lines A, B, C (left column)
    p1a("f1_11[0]"): "Manufacturing",
    p1a("f1_12[0]"): "Handmade goods",
    p1a("f1_13[0]"): "339999",

    # D (EIN), E (Date started), F (Total assets)
    p1f("f1_14[0]"): "39-2788370",
    p1f("f1_15[0]"): "05/05/2025",
    p1f("f1_16[0]"): "1,234",

    # G - Initial return checkbox
    p1f("c1_1[0]"): "/1",

    # H - Cash method
    p1f("c1_6[0]"): "/1",

    # I - Number of K-1s
    p1f("f1_17[0]"): "2",

    # J - Check if partnership is LLC
    p1f("c1_9[0]"): "/1",

    # f1_18 - Check if LLC member managed
    p1f("f1_18[0]"): "2",  # Number of members

    # Income lines - ALL $0
    p1f("f1_21[0]"): "0",
    p1f("f1_22[0]"): "0",
    p1f("f1_23[0]"): "0",
    p1f("f1_24[0]"): "0",
    p1f("f1_25[0]"): "0",
    p1f("f1_26[0]"): "0",
    p1f("f1_27[0]"): "0",
    p1f("f1_28[0]"): "0",
    p1f("f1_29[0]"): "0",
    p1f("f1_30[0]"): "0",

    # Deductions
    p1f("f1_31[0]"): "0",   # Line 9 Salaries
    p1f("f1_32[0]"): "0",   # Line 10 Guaranteed payments
    p1f("f1_33[0]"): "0",   # Line 11 Repairs
    p1f("f1_34[0]"): "0",   # Line 12 Bad debts
    p1f("f1_35[0]"): "0",   # Line 13 Rent
    p1f("f1_39[0]"): "0",   # Line 15 Depletion
    p1f("f1_40[0]"): "0",   # Line 16a
    p1f("f1_41[0]"): "0",   # Line 16b
    p1f("f1_42[0]"): "0",   # Line 17
    p1f("f1_43[0]"): "0",   # Line 18
    p1f("f1_44[0]"): "0",   # Line 19
    p1f("f1_45[0]"): "1,234",   # Line 20 Other deductions
    p1f("f1_46[0]"): "1,234",   # Line 21 Total deductions
    p1f("f1_47[0]"): "(1,234)",  # Line 22 Ordinary business income (loss)
}
writer.update_page_form_field_values(writer.pages[0], page1_fields)

# PAGE 5 - Schedule K (Partners' Distributive Share Items)
page5_fields = {
    "topmostSubform[0].Page5[0].f5_01[0]": "(1,234)",  # Line 1 Ordinary business income
    "topmostSubform[0].Page5[0].f5_02[0]": "0",
    "topmostSubform[0].Page5[0].f5_05[0]": "0",
    "topmostSubform[0].Page5[0].f5_08[0]": "0",
    "topmostSubform[0].Page5[0].f5_09[0]": "0",
    "topmostSubform[0].Page5[0].f5_10[0]": "0",
    "topmostSubform[0].Page5[0].f5_13[0]": "0",
    "topmostSubform[0].Page5[0].f5_14[0]": "0",
    "topmostSubform[0].Page5[0].f5_15[0]": "0",
    "topmostSubform[0].Page5[0].f5_18[0]": "0",
    "topmostSubform[0].Page5[0].f5_20[0]": "0",
    "topmostSubform[0].Page5[0].f5_21[0]": "0",
    "topmostSubform[0].Page5[0].f5_22[0]": "0",
    "topmostSubform[0].Page5[0].f5_23[0]": "0",
    "topmostSubform[0].Page5[0].f5_24[0]": "0",
}
writer.update_page_form_field_values(writer.pages[4], page5_fields)

# PAGE 6 - Analysis + Balance Sheet + M-1 + M-2
page6_fields = {
    # Line 1 Net income
    "topmostSubform[0].Page6[0].f6_01[0]": "(1,234)",

    # Analysis Row A - Nicholas
    "topmostSubform[0].Page6[0].Table_Line2[0].BodyRowA[0].f6_02[0]": "Nicholas Joel Liautaud",
    "topmostSubform[0].Page6[0].Table_Line2[0].BodyRowA[0].f6_04[0]": "(796)",
    "topmostSubform[0].Page6[0].Table_Line2[0].BodyRowA[0].f6_06[0]": "64.5%",
    "topmostSubform[0].Page6[0].Table_Line2[0].BodyRowA[0].f6_07[0]": "(796)",

    # Analysis Row B - William
    "topmostSubform[0].Page6[0].Table_Line2[0].BodyRowB[0].f6_08[0]": "William Swann",
    "topmostSubform[0].Page6[0].Table_Line2[0].BodyRowB[0].f6_10[0]": "(438)",
    "topmostSubform[0].Page6[0].Table_Line2[0].BodyRowB[0].f6_12[0]": "35.5%",
    "topmostSubform[0].Page6[0].Table_Line2[0].BodyRowB[0].f6_13[0]": "(438)",

    # Balance Sheet - Total assets (Line 14)
    "topmostSubform[0].Page6[0].Table_Assets[0].Line14[0].f6_89[0]": "1,234",

    # Partners capital (Line 21)
    "topmostSubform[0].Page6[0].Table_Liabilities[0].Line21[0].f6_121[0]": "0",

    # Total liabilities + capital (Line 22)
    "topmostSubform[0].Page6[0].Table_Liabilities[0].Line22[0].f6_125[0]": "1,234",

    # Schedule M-1
    "topmostSubform[0].Page6[0].SchM-1_Left[0].f6_126[0]": "(1,234)",
    "topmostSubform[0].Page6[0].SchM-1_Left[0].f6_133[0]": "(1,234)",
    "topmostSubform[0].Page6[0].SchM-1_Right[0].f6_141[0]": "(1,234)",

    # Schedule M-2
    "topmostSubform[0].Page6[0].SchM-2_Left[0].f6_142[0]": "0",
    "topmostSubform[0].Page6[0].SchM-2_Left[0].f6_143[0]": "1,234",
    "topmostSubform[0].Page6[0].SchM-2_Left[0].f6_144[0]": "(1,234)",
    "topmostSubform[0].Page6[0].SchM-2_Left[0].f6_145[0]": "0",
    "topmostSubform[0].Page6[0].SchM-2_Left[0].f6_147[0]": "0",
    "topmostSubform[0].Page6[0].SchM-2_Left[0].f6_148[0]": "0",
}
writer.update_page_form_field_values(writer.pages[5], page6_fields)

output_path = f'{BASE}\\SOLUVO_1065_2025_filled.pdf'
writer.write(output_path)
print(f"Form 1065 saved to {output_path}")

# Verify
reader2 = pypdf.PdfReader(output_path)
fields2 = reader2.get_fields()
checks = [
    (p1("f1_04[0]"), "Name"),
    (p1f("f1_14[0]"), "EIN"),
    (p1f("f1_47[0]"), "Line 22"),
    ("topmostSubform[0].Page5[0].f5_01[0]", "Sch K Line 1"),
    ("topmostSubform[0].Page6[0].f6_01[0]", "Analysis Line 1"),
]
for field_name, label in checks:
    f = fields2.get(field_name, {})
    val = f.get('/V', 'NOT SET') if isinstance(f, dict) else 'NOT SET'
    print(f"  {label}: {val}")
