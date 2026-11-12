using System.Globalization;
using System.IO.Compression;
using System.Text;
using System.Xml.Linq;

namespace Hydros.System.UI;

internal sealed record MemorialSection(string Title, string[] Paragraphs, string[]? Columns, string[][]? Rows);

internal static class MemorialWord
{
    private static readonly XNamespace W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
    private static readonly XNamespace Types = "http://schemas.openxmlformats.org/package/2006/content-types";
    private static readonly XNamespace Relationships = "http://schemas.openxmlformats.org/package/2006/relationships";
    private const string RelationshipType = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/";

    public static void Write(Stream output, IReadOnlyList<MemorialSection> sections)
    {
        var body = new XElement(W + "body",
            Paragraph("Memorial de cálculo hidráulico", "Title"),
            Paragraph($"Hydros System · gerado em {DateTime.Now.ToString("g", CultureInfo.GetCultureInfo("pt-BR"))}"));

        foreach (var section in sections)
        {
            body.Add(Paragraph(section.Title, "Heading1"));
            body.Add(section.Paragraphs.Select(value => Paragraph(value)));
            if (section.Columns is not null && section.Rows is not null)
                body.Add(Table(section.Columns, section.Rows));
        }

        body.Add(new XElement(W + "sectPr",
            new XElement(W + "pgSz", new XAttribute(W + "w", 11906), new XAttribute(W + "h", 16838)),
            new XElement(W + "pgMar", new XAttribute(W + "top", 850), new XAttribute(W + "right", 850),
                new XAttribute(W + "bottom", 850), new XAttribute(W + "left", 850),
                new XAttribute(W + "header", 425), new XAttribute(W + "footer", 425), new XAttribute(W + "gutter", 0))));

        using var archive = new ZipArchive(output, ZipArchiveMode.Create, leaveOpen: true);
        AddXml(archive, "[Content_Types].xml", new XElement(Types + "Types",
            new XElement(Types + "Default", new XAttribute("Extension", "rels"),
                new XAttribute("ContentType", "application/vnd.openxmlformats-package.relationships+xml")),
            new XElement(Types + "Override", new XAttribute("PartName", "/word/document.xml"),
                new XAttribute("ContentType", "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml")),
            new XElement(Types + "Override", new XAttribute("PartName", "/word/styles.xml"),
                new XAttribute("ContentType", "application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"))));
        AddXml(archive, "_rels/.rels", Relationship("officeDocument", "word/document.xml"));
        AddXml(archive, "word/_rels/document.xml.rels", Relationship("styles", "styles.xml"));
        AddXml(archive, "word/document.xml", new XElement(W + "document", new XAttribute(XNamespace.Xmlns + "w", W), body));
        AddXml(archive, "word/styles.xml", XElement.Parse("""
            <w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
              <w:style w:type="paragraph" w:default="1" w:styleId="Normal">
                <w:name w:val="Normal"/>
                <w:pPr><w:spacing w:after="100"/></w:pPr>
                <w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial"/><w:sz w:val="21"/><w:lang w:val="pt-BR"/></w:rPr>
              </w:style>
              <w:style w:type="paragraph" w:styleId="Title">
                <w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/>
                <w:pPr><w:keepNext/></w:pPr>
                <w:rPr><w:b/><w:color w:val="233955"/><w:sz w:val="36"/></w:rPr>
              </w:style>
              <w:style w:type="paragraph" w:styleId="Heading1">
                <w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/>
                <w:pPr><w:keepNext/><w:spacing w:before="220" w:after="100"/><w:outlineLvl w:val="0"/></w:pPr>
                <w:rPr><w:b/><w:color w:val="233955"/><w:sz w:val="26"/></w:rPr>
              </w:style>
              <w:style w:type="paragraph" w:styleId="ReportCell">
                <w:name w:val="Report Cell"/><w:basedOn w:val="Normal"/>
                <w:pPr><w:spacing w:before="55" w:after="55"/></w:pPr>
                <w:rPr><w:sz w:val="18"/></w:rPr>
              </w:style>
            </w:styles>
            """));
    }

    private static XElement Relationship(string type, string target) =>
        new(Relationships + "Relationships", new XElement(Relationships + "Relationship",
            new XAttribute("Id", "rId1"), new XAttribute("Type", RelationshipType + type), new XAttribute("Target", target)));

    private static void AddXml(ZipArchive archive, string path, XElement content)
    {
        using var entry = archive.CreateEntry(path).Open();
        content.Save(entry);
    }

    private static XElement Paragraph(string value, string? style = null, bool bold = false) =>
        new(W + "p", style is null ? null : new XElement(W + "pPr", new XElement(W + "pStyle", new XAttribute(W + "val", style))),
            new XElement(W + "r", bold ? new XElement(W + "rPr", new XElement(W + "b")) : null,
                new XElement(W + "t", new XAttribute(XNamespace.Xml + "space", "preserve"), XmlText(value))));

    private static string XmlText(string value)
    {
        var text = new StringBuilder(value.Length);
        foreach (var rune in value.EnumerateRunes())
            text.Append(rune.Value is 0x09 or 0x0A or 0x0D or (>= 0x20 and <= 0xD7FF)
                or (>= 0xE000 and <= 0xFFFD) or (>= 0x10000 and <= 0x10FFFF) ? rune.ToString() : "\uFFFD");
        return text.ToString();
    }

    private static XElement Table(string[] columns, string[][] rows)
    {
        // A4 with 15 mm margins. Leave more room for identification and source text.
        int[] widths = columns.Length switch
        {
            5 => [750, 1600, 1050, 2850, 3956],
            7 => [2050, 830, 1310, 1310, 1250, 2170, 1286],
            9 => [880, 900, 850, 800, 800, 850, 850, 980, 3296],
            _ => throw new ArgumentException("O memorial só oferece tabelas com 5, 7 ou 9 colunas.", nameof(columns))
        };
        var borders = new[] { "top", "left", "bottom", "right", "insideH", "insideV" };
        return new XElement(W + "tbl",
            new XElement(W + "tblPr",
                new XElement(W + "tblW", new XAttribute(W + "w", widths.Sum()), new XAttribute(W + "type", "dxa")),
                new XElement(W + "tblBorders", borders.Select(edge => new XElement(W + edge,
                    new XAttribute(W + "val", "single"), new XAttribute(W + "sz", "4"), new XAttribute(W + "color", "CBD3DC")))),
                new XElement(W + "tblLayout", new XAttribute(W + "type", "fixed"))),
            new XElement(W + "tblGrid", widths.Select(width => new XElement(W + "gridCol", new XAttribute(W + "w", width)))),
            Row(columns, widths, header: true),
            rows.Select(row => Row(row, widths)));
    }

    private static XElement Row(string[] values, int[] widths, bool header = false) =>
        new(W + "tr",
            new XElement(W + "trPr", new XElement(W + "cantSplit"), header ? new XElement(W + "tblHeader") : null),
            values.Select((value, index) => new XElement(W + "tc",
                new XElement(W + "tcPr",
                    new XElement(W + "tcW", new XAttribute(W + "w", widths[index]), new XAttribute(W + "type", "dxa")),
                    header ? new XElement(W + "shd", new XAttribute(W + "val", "clear"), new XAttribute(W + "fill", "EAF0F5")) : null),
                Paragraph(value, "ReportCell", bold: header))));
}
