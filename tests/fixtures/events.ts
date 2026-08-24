export function eventFeature(
  id: number,
  slug: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const properties = {
    eventname: slug,
    EventLongName: `${slug} parkrun`,
    EventShortName: slug,
    LocalisedEventLongName: null,
    countrycode: 97,
    seriesid: 1,
    EventLocation: `${slug} park`,
    ...(overrides.properties as Record<string, unknown> | undefined),
  };

  return {
    id,
    type: "Feature",
    geometry: {
      type: "Point",
      coordinates: [-0.335791, 51.410992],
      ...(overrides.geometry as Record<string, unknown> | undefined),
    },
    properties,
    ...Object.fromEntries(
      Object.entries(overrides).filter(([key]) =>
        key !== "properties" && key !== "geometry"
      ),
    ),
  };
}

export function eventsDocument(
  features: readonly Record<string, unknown>[],
): Record<string, unknown> {
  return {
    countries: {
      "97": {
        url: "www.parkrun.org.uk",
        bounds: [-8.61772, 49.9029, 1.76891, 59.3608],
      },
    },
    events: {
      type: "FeatureCollection",
      features,
    },
  };
}
