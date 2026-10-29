import csv
import json
import math
import sys
from collections import defaultdict
from datetime import datetime
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "iem_pireps_bulk_300k.csv"
OUTPUT = ROOT / "public" / "pirep-region-model.json"
CELL_SIZE = 0.5
MIN_CELL_REPORTS = 3
ROUTE_START = (25.273, 51.608)
ROUTE_END = (10.152, 76.401)
ROUTE_SUPPORT_RADIUS_KM = 100


def turbulence_class(value):
    text = (value or "").strip().upper()
    if not text or text == "NONE":
        return None
    if text in {"NEG", "SMOOTH", "SMOOTH AIR", "NO TURBULENCE"}:
        return "smooth"
    if "SEV" in text or "EXTREME" in text:
        return "severe"
    if "MOD" in text:
        return "moderate"
    if "LGT" in text or "LIGHT" in text or "CHOP" in text:
        return "light"
    return None


def flight_level_band(value):
    try:
        altitude = float(value)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(altitude) or altitude <= 0:
        return None
    if altitude < 18000:
        return "low"
    if altitude < 30000:
        return "mid"
    if altitude < 45000:
        return "high"
    return None


def route_distance_km(latitude, longitude):
    reference_latitude = math.radians(latitude)
    km_per_degree = 111.2

    def project(point):
        return (
            point[1] * km_per_degree * math.cos(reference_latitude),
            point[0] * km_per_degree,
        )

    point = project((latitude, longitude))
    start = project(ROUTE_START)
    end = project(ROUTE_END)
    dx = end[0] - start[0]
    dy = end[1] - start[1]
    length_squared = dx * dx + dy * dy
    fraction = 0 if not length_squared else max(
        0,
        min(
            1,
            ((point[0] - start[0]) * dx + (point[1] - start[1]) * dy)
            / length_squared,
        ),
    )
    return math.hypot(
        point[0] - (start[0] + fraction * dx),
        point[1] - (start[1] + fraction * dy),
    )


def parse_report_time(value):
    try:
        return datetime.strptime(value[:12], "%Y%m%d%H%M").strftime("%Y-%m-%d")
    except (TypeError, ValueError):
        return None


def main():
    if not SOURCE.is_file():
        raise FileNotFoundError(f"Dataset not found: {SOURCE}")

    csv.field_size_limit(sys.maxsize)
    cells = defaultdict(lambda: {"light": 0, "moderate": 0, "severe": 0})
    totals = {
        "rows": 0,
        "valid_coordinates": 0,
        "labeled_turbulence": 0,
        "flight_level_reports": 0,
        "smooth": 0,
    }
    route_support = 0
    dates = []

    with SOURCE.open(newline="", encoding="utf-8-sig", errors="replace") as dataset:
        for row in csv.DictReader(dataset):
            totals["rows"] += 1
            try:
                latitude = float(row["LAT"])
                longitude = float(row["LON"])
            except (KeyError, TypeError, ValueError):
                continue
            if not (
                math.isfinite(latitude)
                and math.isfinite(longitude)
                and -90 <= latitude <= 90
                and -180 <= longitude <= 180
            ):
                continue
            totals["valid_coordinates"] += 1

            band = flight_level_band(row.get("FL"))
            label = turbulence_class(row.get("TURBULENCE"))
            if label == "smooth":
                totals["smooth"] += 1
                continue
            if label not in {"light", "moderate", "severe"}:
                continue

            totals["labeled_turbulence"] += 1
            date = parse_report_time(row.get("VALID"))
            if date:
                dates.append(date)
            if band != "high":
                continue

            totals["flight_level_reports"] += 1
            cell = (
                math.floor(latitude / CELL_SIZE) * CELL_SIZE,
                math.floor(longitude / CELL_SIZE) * CELL_SIZE,
            )
            cells[cell][label] += 1
            if route_distance_km(latitude, longitude) <= ROUTE_SUPPORT_RADIUS_KM:
                route_support += 1

    regions = []
    for (south, west), counts in cells.items():
        sample_count = sum(counts.values())
        if sample_count < MIN_CELL_REPORTS:
            continue
        mean_intensity = (
            counts["light"] + 2 * counts["moderate"] + 3 * counts["severe"]
        ) / sample_count
        level = "low" if mean_intensity < 1.65 else (
            "moderate" if mean_intensity < 2.35 else "high"
        )
        regions.append(
            [
                round(south, 2),
                round(west, 2),
                sample_count,
                level,
                round(mean_intensity, 2),
                counts["light"],
                counts["moderate"],
                counts["severe"],
            ]
        )

    model = {
        "version": 1,
        "method": "Historical spatial severity estimator",
        "resolutionDegrees": CELL_SIZE,
        "flightLevelBand": "FL300-FL450",
        "minimumReportsPerRegion": MIN_CELL_REPORTS,
        "sourceRows": totals["rows"],
        "geocodedRows": totals["valid_coordinates"],
        "labeledTurbulenceReports": totals["labeled_turbulence"],
        "flightLevelTrainingReports": totals["flight_level_reports"],
        "explicitSmoothReports": totals["smooth"],
        "dateRange": [min(dates), max(dates)] if dates else [],
        "routeSupportRadiusKm": ROUTE_SUPPORT_RADIUS_KM,
        "routeReportsWithinSupport": route_support,
        "regions": regions,
    }

    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(json.dumps(model, separators=(",", ":")), encoding="utf-8")
    print(
        f"Built {len(regions)} FL300-FL450 regions from "
        f"{totals['labeled_turbulence']} labeled reports "
        f"({totals['rows']} source rows); "
        f"{route_support} reports within {ROUTE_SUPPORT_RADIUS_KM} km of the route."
    )
    print(f"Output: {OUTPUT} ({OUTPUT.stat().st_size:,} bytes)")


if __name__ == "__main__":
    main()
