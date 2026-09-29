"""Offline, filename-independent file-format detector for the DropVault pilot.

This is a bounded experiment, not an upload security validator. It reads at most
8 MiB and returns UNKNOWN when a format cannot be checked conservatively.
"""

from __future__ import annotations

import argparse
import csv
import io
import json
import math
import re
import xml.etree.ElementTree as ET
import zlib
from dataclasses import asdict, dataclass
from pathlib import Path
from zipfile import BadZipFile, ZipFile


MAX_INPUT_BYTES = 8 * 1024 * 1024
MAX_ZIP_ENTRIES = 2048
MAX_EXPANDED_BYTES = 32 * 1024 * 1024
MAX_XML_BYTES = 256 * 1024
MAX_CSV_PREAMBLE_LINES = 32
MAX_CSV_PREAMBLE_CHARS = 4096
MAX_CSV_PREAMBLE_TABLE_CHARS = 256 * 1024

OFFICE_PARTS = {
    "DOCX": (
        "word/document.xml",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml",
        "document",
    ),
    "PPTX": (
        "ppt/presentation.xml",
        "application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml",
        "presentation",
    ),
    "XLSX": (
        "xl/workbook.xml",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml",
        "workbook",
    ),
}


@dataclass(frozen=True)
class Detection:
    label: str
    reason: str


def _office_or_zip(raw: bytes) -> Detection:
    try:
        with ZipFile(io.BytesIO(raw)) as archive:
            entries = archive.infolist()
            if len(entries) > MAX_ZIP_ENTRIES:
                return Detection("UNKNOWN", "too_many_zip_entries")
            if sum(entry.file_size for entry in entries) > MAX_EXPANDED_BYTES:
                return Detection("UNKNOWN", "zip_expansion_limit")
            if any(entry.flag_bits & 1 for entry in entries):
                return Detection("UNKNOWN", "encrypted_zip")
            names = {entry.filename for entry in entries}
            if len(names) != len(entries):
                return Detection("UNKNOWN", "duplicate_zip_names")
            present = [label for label, (part, _, _) in OFFICE_PARTS.items()
                       if part in names]
            if len(present) > 1:
                return Detection("UNKNOWN", "conflicting_office_parts")
            if present:
                if not {"[Content_Types].xml", "_rels/.rels"} <= names:
                    return Detection("UNKNOWN", "incomplete_office_package")
                label = present[0]
                part, expected_type, expected_root = OFFICE_PARTS[label]
                xml_entry = archive.getinfo("[Content_Types].xml")
                main_entry = archive.getinfo(part)
                rels_entry = archive.getinfo("_rels/.rels")
                if any(entry.file_size > MAX_XML_BYTES
                       for entry in (xml_entry, main_entry, rels_entry)):
                    return Detection("UNKNOWN", "office_xml_too_large")
                content_types = ET.fromstring(archive.read(xml_entry))
                relationships = ET.fromstring(archive.read(rels_entry))
                main_document = ET.fromstring(archive.read(main_entry))
                if (content_types.tag.split("}")[-1] != "Types"
                        or relationships.tag.split("}")[-1] != "Relationships"
                        or main_document.tag.split("}")[-1] != expected_root):
                    return Detection("UNKNOWN", "office_xml_structure_mismatch")
                found = any(
                    node.attrib.get("PartName") == "/" + part
                    and node.attrib.get("ContentType") == expected_type
                    for node in content_types
                )
                if not found:
                    return Detection("UNKNOWN", "office_manifest_mismatch")
                return Detection(label, "office_manifest_and_main_part")
            if "[Content_Types].xml" in names:
                return Detection("UNKNOWN", "unrecognized_office_package")
            if {"META-INF/manifest.xml", "content.xml"} <= names:
                return Detection("OUT_OF_SCOPE", "open_document_package")
            if "mimetype" in names:
                mime_entry = archive.getinfo("mimetype")
                if mime_entry.file_size <= 128:
                    mime = archive.read(mime_entry)
                    if mime.startswith((b"application/epub+zip",
                                        b"application/vnd.oasis.opendocument.")):
                        return Detection("OUT_OF_SCOPE", "other_known_zip_package")
            return Detection("ZIP", "valid_zip_container")
    except (BadZipFile, EOFError, RuntimeError, ValueError, zlib.error, ET.ParseError):
        return Detection("UNKNOWN", "invalid_zip_or_office_package")


def _csv_delimiters(value: str) -> tuple[list[str], bool]:
    matches = []
    short_table = False
    for delimiter in (",", "\t", ";", "|"):
        try:
            rows = [row for row in csv.reader(io.StringIO(value), delimiter=delimiter,
                                              strict=True) if row]
        except csv.Error:
            continue
        widths = {len(row) for row in rows}
        if len(rows) >= 2 and len(widths) == 1 and next(iter(widths)) >= 2:
            # Two prose lines containing commas are too easy to mistake for CSV.
            if len(rows) == 2:
                short_table = True
            elif any(_is_number(cell) for row in rows[1:] for cell in row):
                matches.append(delimiter)
            else:
                # Equal-width prose and an all-text table are indistinguishable
                # without a stronger signal. Abstain rather than guess CSV.
                short_table = True
    return matches, short_table


def _csv_after_preamble(value: str) -> list[str]:
    """Find a bounded metadata preamble before an unambiguous data table.

    This is intentionally stricter than ordinary CSV detection: the preamble
    must be single-field text, and the table needs a header and numeric data.
    """
    if len(value) > MAX_CSV_PREAMBLE_TABLE_CHARS:
        return []
    lines = value.splitlines(keepends=True)
    matches = []
    for delimiter in (",", "\t", ";", "|"):
        preamble_chars = 0
        for start in range(1, min(len(lines) - 2, MAX_CSV_PREAMBLE_LINES) + 1):
            previous = lines[start - 1]
            preamble_chars += len(previous)
            if preamble_chars > MAX_CSV_PREAMBLE_CHARS:
                break
            try:
                prefix = list(csv.reader(io.StringIO(previous), delimiter=delimiter,
                                         strict=True))
            except csv.Error:
                break
            if any(len(row) > 1 for row in prefix):
                break
            try:
                rows = [row for row in csv.reader(
                    io.StringIO("".join(lines[start:])), delimiter=delimiter,
                    strict=True) if row]
            except csv.Error:
                continue
            if len(rows) < 3 or len(rows[0]) < 3:
                continue
            width = len(rows[0])
            if any(len(row) != width for row in rows):
                continue
            header = [cell.strip() for cell in rows[0]]
            if (any(not cell or len(cell) > 64 or "\n" in cell for cell in header)
                    or len(set(header)) != width
                    or any(not re.match(r"^[A-Za-z_][\w .()/%+-]*$", cell)
                           for cell in header)):
                continue
            if not all(any(_is_number(cell) for cell in row)
                       for row in rows[1:3]):
                continue
            matches.append(delimiter)
            break
    return matches


def _is_number(value: str) -> bool:
    try:
        return bool(value.strip()) and math.isfinite(float(value))
    except ValueError:
        return False


def _has_pdf_xref(raw: bytes) -> bool:
    """Require a plausible cross-reference target, without claiming PDF validity."""
    trailer = re.search(rb"startxref\s+(\d+)\s+%%EOF\s*$", raw[-2048:])
    if not trailer:
        return False
    offset = int(trailer.group(1))
    if offset >= len(raw):
        return False
    target = raw[offset:offset + 1024]
    if target.startswith(b"xref"):
        return True
    return bool(re.match(rb"\d+\s+\d+\s+obj\b", target)
                and re.search(rb"/Type\s*/XRef\b", target))


def detect_bytes(raw: bytes) -> Detection:
    """Identify content without inspecting a filename or browser MIME hint."""
    if not raw or len(raw) > MAX_INPUT_BYTES:
        return Detection("UNKNOWN", "empty_or_input_limit")

    if raw.startswith(b"%PDF-"):
        if re.match(rb"%PDF-\d\.\d", raw[:8]) and _has_pdf_xref(raw):
            return Detection("PDF", "pdf_header_and_cross_reference")
        return Detection("UNKNOWN", "incomplete_pdf")

    if raw.startswith((b"PK\x03\x04", b"PK\x05\x06", b"PK\x07\x08")):
        return _office_or_zip(raw)

    signatures = (
        (raw.startswith(b"\x89PNG\r\n\x1a\n"), "png"),
        (raw.startswith(b"\xff\xd8\xff"), "jpeg"),
        (raw.startswith((b"GIF87a", b"GIF89a")), "gif"),
        (raw[:4] == b"RIFF" and raw[8:12] in (b"WEBP", b"WAVE"), "riff_media"),
        (raw.startswith(b"\x1f\x8b"), "gzip"),
        (raw.startswith(b"BZh"), "bzip2"),
        (raw[257:262] == b"ustar", "tar"),
        (raw[4:8] == b"ftyp", "mp4_family"),
    )
    for matches, kind in signatures:
        if matches:
            return Detection("OUT_OF_SCOPE", kind)

    try:
        value = raw.decode("utf-8-sig")
    except UnicodeDecodeError:
        return Detection("UNKNOWN", "unrecognized_binary_or_encoding")
    if not value.strip() or any(ord(char) < 32 and char not in "\t\n\r\f" for char in value):
        return Detection("UNKNOWN", "empty_or_control_character_text")

    trimmed = value.lstrip()
    if re.match(r"(?is)^<!doctype\s+html\b|^<html(?:\s|>)", trimmed):
        return Detection("OUT_OF_SCOPE", "html_markup")
    if trimmed.startswith("<"):
        try:
            ET.fromstring(value)
            return Detection("OUT_OF_SCOPE", "xml_markup")
        except ET.ParseError:
            return Detection("UNKNOWN", "ambiguous_or_malformed_markup")

    try:
        parsed = json.loads(value)
    except json.JSONDecodeError:
        if trimmed.startswith(("{", "[")):
            return Detection("UNKNOWN", "malformed_json_like_text")
    else:
        if isinstance(parsed, (dict, list)):
            return Detection("JSON", "parsed_json_object_or_array")
        return Detection("UNKNOWN", "ambiguous_json_scalar")

    delimiters, short_table = _csv_delimiters(value)
    if len(delimiters) == 1:
        return Detection("CSV", "consistent_delimited_table")
    if len(delimiters) > 1:
        return Detection("UNKNOWN", "ambiguous_delimiters")
    if short_table:
        return Detection("UNKNOWN", "ambiguous_text_table")
    preamble_delimiters = _csv_after_preamble(value)
    if len(preamble_delimiters) == 1:
        return Detection("CSV", "delimited_table_after_text_preamble")
    if len(preamble_delimiters) > 1:
        return Detection("UNKNOWN", "ambiguous_delimiters_after_preamble")
    return Detection("TXT", "unstructured_utf8_text")


def detect_file(path: Path) -> Detection:
    size = path.stat().st_size
    if size > MAX_INPUT_BYTES:
        return Detection("UNKNOWN", "input_limit")
    return detect_bytes(path.read_bytes())


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("path", type=Path)
    args = parser.parse_args()
    print(json.dumps(asdict(detect_file(args.path))))
