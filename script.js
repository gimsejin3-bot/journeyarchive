(() => {
  "use strict";

  const data = window.JOURNEY_ARCHIVE_DATA;
  if (!data) return;

  const $ = (selector, root = document) => root.querySelector(selector);
  const escapeHTML = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[char]);
  const safeURL = (value) => /^https:\/\//i.test(value || "") ? escapeHTML(value) : "#";
  const mapSearchURL = (query) => `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;

  const countryList = $("#country-list");
  const countryDetails = $("#country-details");
  const accordionHost = $("#country-accordions");
  const mapElement = $("#travel-map");
  const mapViewport = $(".map-viewport");
  const mapFallbackMessage = $("#map-fallback-message");
  const mapOpenLink = $("#open-google-map");
  const mapStatus = $("#map-status");
  const mapCaption = $("#map-caption");
  const safetyCountryList = $("#safety-country-list");
  const searchForm = $("#destination-search");
  const searchInput = $("#destination-query");
  const searchResults = $("#destination-results");
  const searchFeedback = $("#search-feedback");
  let selectedCountryId = null;
  let searchIndex = [];
  let currentSearchMatches = [];
  let lastActivatedSearch = "";
  let mapInstance = null;
  let mapProvider = "none";
  let countryMarkers = [];
  let routeMarkers = [];
  let routePolyline = null;
  let activeInfoWindow = null;
  let hoverInfoWindow = null;
  let pinnedInfoSpot = null;
  let selectedRouteId = null;
  let pendingRouteId = null;
  let pendingSpotOrder = null;

  const countries = data.countries || [];
  const routes = data.routes || [];
  const countryById = new Map(countries.map((country) => [country.id, country]));

  function googleDirectionsURL(route) {
    const country = countryById.get(route.countryId);
    const spots = route.routeSpots || [];
    if (!spots.length) return mapSearchURL(`${route.title} ${country?.name || ""}`);
    const placeName = (spot) => `${spot.name} ${country?.name || ""}`.trim();
    const params = new URLSearchParams({
      api: "1",
      origin: placeName(spots[0]),
      destination: placeName(spots[spots.length - 1]),
      travelmode: "walking"
    });
    if (spots.length > 2) params.set("waypoints", spots.slice(1, -1).map(placeName).join("|"));
    return `https://www.google.com/maps/dir/?${params.toString()}`;
  }

  const photoCache = new Map();
  const photoRequests = new Map();
  let hoverSpot = null;
  let lastHoverSpot = null;
  let lastHoverMarker = null;

  function photoCacheKey(spot, country) {
    return `${country?.id || "unknown"}:${spot.order}:${spot.name}:${spot.lat},${spot.lng}`.toLocaleLowerCase();
  }

  function commonsSearchQuery(spot, country) {
    return String(spot.photoQuery || `${spot.name || ""} ${spot.city || ""} ${country?.name || ""}`).trim();
  }

  function placesSearchQuery(spot, country) {
    const name = String(spot.name || "");
    const typeHints = [
      [/카날|운하/i, "canal"], [/광장/i, "square"], [/지구/i, "neighborhood"],
      [/미술관/i, "art museum"], [/박물관/i, "museum"], [/대성당|성당/i, "cathedral"],
      [/궁전/i, "palace"], [/사원|절/i, "temple"], [/성|성채/i, "castle"],
      [/다리/i, "bridge"], [/공원/i, "park"], [/정원/i, "garden"],
      [/시장/i, "market"], [/폭포/i, "waterfall"], [/기념관/i, "memorial"]
    ];
    const hint = typeHints.find(([pattern]) => pattern.test(name))?.[1] || "";
    return [name, hint, spot.city, country?.name].filter(Boolean).join(", ");
  }

  function fetchCommonsPhoto(spot, country) {
    const query = commonsSearchQuery(spot, country);
    if (!query) return Promise.resolve(null);
    const url = `https://commons.wikimedia.org/w/api.php?action=query&generator=search&gsrsearch=${encodeURIComponent(query)}&gsrnamespace=6&gsrlimit=1&prop=imageinfo&iiprop=url&iiurlwidth=400&format=json&origin=*`;
    return fetch(url).then((response) => response.json()).then((payload) => {
      const pages = payload?.query?.pages ? Object.values(payload.query.pages) : [];
      const page = pages[0];
      const image = page?.imageinfo?.[0]?.thumburl;
      return image ? { url: image, attribution: "Wikimedia Commons", attributionUrl: page.fullurl || "https://commons.wikimedia.org/" } : null;
    }).catch(() => null);
  }

  async function fetchGooglePlacePhoto(spot, country) {
    const key = data.mapConfig?.placesApiKey;
    if (!key) return null;
    try {
      const response = await fetch("https://places.googleapis.com/v1/places:searchText", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Goog-Api-Key": key,
          "X-Goog-FieldMask": "places.displayName,places.primaryType,places.photos.name,places.photos.authorAttributions.displayName,places.photos.authorAttributions.uri,places.location"
        },
        body: JSON.stringify({
          textQuery: placesSearchQuery(spot, country),
          maxResultCount: 10,
          rankPreference: "DISTANCE",
          locationBias: { circle: { center: { latitude: spot.lat, longitude: spot.lng }, radius: 1200 } }
        })
      });
      if (!response.ok) return null;
      const result = await response.json();
      const distanceFromSpot = (place) => {
        if (!place.location) return Infinity;
        const radians = (degrees) => degrees * Math.PI / 180;
        const dLat = radians(place.location.latitude - spot.lat);
        const dLng = radians(place.location.longitude - spot.lng);
        const a = Math.sin(dLat / 2) ** 2 + Math.cos(radians(spot.lat)) * Math.cos(radians(place.location.latitude)) * Math.sin(dLng / 2) ** 2;
        return 6371000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
      };
      const nonLandmarkTypes = new Set(["hotel", "lodging", "hostel", "motel", "bed_and_breakfast", "resort_hotel"]);
      const place = (result.places || [])
        .filter((candidate) => candidate.photos?.length && !nonLandmarkTypes.has(candidate.primaryType) && distanceFromSpot(candidate) <= 1500)
        .sort((a, b) => distanceFromSpot(a) - distanceFromSpot(b))[0];
      const photo = place?.photos?.[0];
      if (!photo?.name) return null;
      const mediaResponse = await fetch(`https://places.googleapis.com/v1/${photo.name}/media?maxWidthPx=400&skipHttpRedirect=true&key=${encodeURIComponent(key)}`);
      if (!mediaResponse.ok) return null;
      const media = await mediaResponse.json();
      const authors = (photo.authorAttributions || []).map((author) => ({
        name: author.displayName || "",
        url: author.uri || "https://maps.google.com/"
      }));
      return media.photoUri ? {
        url: media.photoUri,
        attributions: authors.length ? authors : [{ name: "Google Maps", url: "https://maps.google.com/" }]
      } : null;
    } catch (error) {
      return null;
    }
  }

  function getSpotPhoto(spot, country) {
    const key = photoCacheKey(spot, country);
    if (photoCache.has(key)) return Promise.resolve(photoCache.get(key));
    if (photoRequests.has(key)) return photoRequests.get(key);
    const request = fetchGooglePlacePhoto(spot, country)
      .then((photo) => photo || fetchCommonsPhoto(spot, country))
      .then((photo) => {
        photoCache.set(key, photo || null);
        photoRequests.delete(key);
        return photo || null;
      })
      .catch(() => {
        photoCache.set(key, null);
        photoRequests.delete(key);
        return null;
      });
    photoRequests.set(key, request);
    return request;
  }

  function updateSpotCard(spot, country) {
    const key = photoCacheKey(spot, country);
    if (!photoCache.has(key)) return;
    const markup = mapInfoMarkup(spot, photoCache.get(key));
    if ((hoverSpot === spot || lastHoverSpot === spot) && mapProvider === "google" && hoverInfoWindow?.getMap()) hoverInfoWindow.setContent(markup);
    if (pinnedInfoSpot === spot && mapProvider === "google" && activeInfoWindow) activeInfoWindow.setContent(markup);
    const entry = routeMarkers.find((item) => item.spot === spot);
    if (!entry) return;
    if (mapProvider === "leaflet" && entry.marker.getTooltip()) entry.marker.setTooltipContent(markup);
    if (mapProvider === "leaflet" && entry.marker.isPopupOpen()) entry.marker.setPopupContent(markup);
  }

  function refreshSpotPhoto(spot, country) {
    getSpotPhoto(spot, country).then((url) => {
      if (url) updateSpotCard(spot, country);
    });
  }

  function mapInfoMarkup(spot, placePhotoUrl = null) {
    const cached = placePhotoUrl || photoCache.get(photoCacheKey(spot, countryById.get(spot.countryId)));
    // Generic route photos are not presented as a specific landmark photo. Wait for Places/Commons,
    // unless the spot carries an explicitly user-verified image.
    const fallbackImage = spot.imageVerified ? spot.image : "";
    const image = safeURL(cached?.url || fallbackImage);
    const hasImage = image !== "#";
    const credits = cached?.attributions || (cached?.attribution ? [{ name: cached.attribution, url: cached.attributionUrl }] : []);
    const credit = credits.length
      ? `<div class="map-info-attribution">${credits.map((item) => `<a href="${safeURL(item.url)}" target="_blank" rel="noopener noreferrer">${escapeHTML(item.name || "Photo credit")}</a>`).join(" · ")}</div>`
      : "";
    const photo = `<div class="map-info-photo-frame">
      ${hasImage ? `<img class="map-info-photo" src="${image}" alt="${escapeHTML(spot.name)}" onerror="this.style.display='none';this.parentElement.querySelector('.map-info-photo-fallback').style.display='flex';this.parentElement.querySelector('.map-info-attribution')?.remove();">` : ""}
      <div class="map-info-photo-fallback" style="display:${hasImage ? "none" : "flex"}"><span aria-hidden="true">⌖</span><strong>${escapeHTML(spot.name)}</strong></div>
      ${credit}
    </div>`;
    return `<div class="map-info-window">
      ${photo}
      <div class="map-info-body">
        <span class="map-info-badge">SPOT ${String(spot.order).padStart(2, "0")}</span>
        <strong>${escapeHTML(spot.name)}</strong>
        <p>${escapeHTML(spot.desc || "여행 루트 스팟")}</p>
      </div>
    </div>`;
  }

  function openSpotHoverCard(spot, marker, country) {
    hoverSpot = spot;
    lastHoverSpot = spot;
    lastHoverMarker = marker;
    const photoUrl = photoCache.get(photoCacheKey(spot, country)) || null;
    if (mapProvider === "google") {
      if (!hoverInfoWindow) hoverInfoWindow = new google.maps.InfoWindow({ disableAutoPan: true });
      hoverInfoWindow.setContent(mapInfoMarkup(spot, photoUrl));
      hoverInfoWindow.open({ map: mapInstance, anchor: marker });
    } else if (mapProvider === "leaflet") {
      marker.bindTooltip(mapInfoMarkup(spot, photoUrl), {
        direction: "top",
        offset: [0, -18],
        opacity: 1,
        className: "spot-hover-tooltip",
        interactive: false
      });
      marker.openTooltip();
    }
    refreshSpotPhoto(spot, country);
  }

  function closeSpotHoverCard(marker) {
    hoverSpot = null;
    if (mapProvider === "google") {
      if (hoverInfoWindow) hoverInfoWindow.close();
    } else if (mapProvider === "leaflet") {
      marker.closeTooltip();
    }
    if (pinnedInfoSpot) {
      const pinned = routeMarkers.find((entry) => entry.spot === pinnedInfoSpot);
      if (!pinned) return;
      if (mapProvider === "google") {
        activeInfoWindow.setContent(mapInfoMarkup(pinnedInfoSpot, photoCache.get(photoCacheKey(pinnedInfoSpot, pinned.country)) || null));
        activeInfoWindow.open({ map: mapInstance, anchor: pinned.marker });
      } else if (mapProvider === "leaflet" && !pinned.marker.isPopupOpen()) {
        pinned.marker.openPopup();
      }
      refreshSpotPhoto(pinnedInfoSpot, pinned.country);
    }
  }

  function clearRouteLayers() {
    if (activeInfoWindow && mapProvider === "google") activeInfoWindow.close();
    if (mapProvider === "google") {
      routeMarkers.forEach(({ marker }) => marker.setMap(null));
      if (routePolyline) routePolyline.setMap(null);
    } else if (mapProvider === "leaflet" && mapInstance) {
      routeMarkers.forEach(({ marker }) => mapInstance.removeLayer(marker));
      if (routePolyline) mapInstance.removeLayer(routePolyline);
    }
    routeMarkers = [];
    routePolyline = null;
    activeInfoWindow = null;
    pinnedInfoSpot = null;
    if (hoverInfoWindow) hoverInfoWindow.close();
    selectedRouteId = null;
    updateOverviewVisibility(mapInstance ? mapInstance.getZoom() : 2);
    countryDetails.querySelectorAll(".route-step.is-active").forEach((step) => step.classList.remove("is-active"));
    countryDetails.querySelectorAll(".mini-route-card.is-active").forEach((card) => card.classList.remove("is-active"));
  }

  function setRouteSelection(routeId, spotOrder = null) {
    selectedRouteId = routeId;
    countryDetails.querySelectorAll("[data-route-card]").forEach((card) => {
      card.classList.toggle("is-active", card.dataset.routeCard === routeId);
    });
    countryDetails.querySelectorAll("[data-route-step]").forEach((step) => {
      const active = step.dataset.routeStep === routeId && Number(step.dataset.spotOrder) === Number(spotOrder);
      step.classList.toggle("is-active", active);
      if (active) step.setAttribute("aria-current", "step");
      else step.removeAttribute("aria-current");
    });
    routeMarkers.forEach(({ marker, spot }) => {
      const active = routeId === selectedRouteId && Number(spot.order) === Number(spotOrder);
      if (mapProvider === "google") {
        marker.setIcon(googleRouteIcon(spot.order, active));
        marker.setZIndex(active ? 1000 : undefined);
      } else if (mapProvider === "leaflet") {
        marker.getElement()?.querySelector(".map-route-pin")?.classList.toggle("is-active", active);
      }
    });
  }

  function googleRouteIcon(order, active = false) {
    return {
      path: google.maps.SymbolPath.CIRCLE,
      scale: active ? 17 : 14,
      fillColor: active ? "#0075de" : "#ff385c",
      fillOpacity: 1,
      strokeColor: "#ffffff",
      strokeWeight: 3,
      labelOrigin: new google.maps.Point(0, 0)
    };
  }

  function focusRouteSpot(routeId, order) {
    const markerEntry = routeMarkers.find(({ spot }) => Number(spot.order) === Number(order));
    if (!markerEntry || selectedRouteId !== routeId) return;
    setRouteSelection(routeId, order);
    const { marker, spot } = markerEntry;
    if (mapProvider === "google") {
      mapInstance.panTo({ lat: spot.lat, lng: spot.lng });
      if (mapInstance.getZoom() < 15) mapInstance.setZoom(15);
      marker.setAnimation(google.maps.Animation.BOUNCE);
      window.setTimeout(() => marker.setAnimation(null), 700);
    } else if (mapProvider === "leaflet") {
      mapInstance.flyTo([spot.lat, spot.lng], Math.max(mapInstance.getZoom(), 15), { duration: .7 });
      marker.openPopup();
    }
  }

  function drawRouteOnMap(routeId, { focusOrder = null } = {}) {
    const route = routes.find((item) => item.id === routeId);
    if (!route) return;
    const country = countryById.get(route.countryId);
    pendingRouteId = routeId;
    pendingSpotOrder = focusOrder;
    if (!mapInstance) return;
    const spots = route.routeSpots || [];
    if (!spots.length) return;
    const routePath = route.coordinates?.length
      ? route.coordinates.map(([lat, lng]) => ({ lat, lng }))
      : spots.map((spot) => ({ lat: spot.lat, lng: spot.lng }));
    clearRouteLayers();
    selectedRouteId = routeId;

    if (mapProvider === "google") {
      routePolyline = new google.maps.Polyline({
        path: routePath,
        geodesic: true,
        strokeColor: "#ff385c",
        strokeOpacity: .94,
        strokeWeight: 4,
        map: mapInstance
      });
      activeInfoWindow = new google.maps.InfoWindow();
      routeMarkers = spots.map((spot) => {
        const marker = new google.maps.Marker({
          position: { lat: spot.lat, lng: spot.lng },
          map: mapInstance,
          title: `${spot.order}. ${spot.name}`,
          icon: googleRouteIcon(spot.order),
          label: { text: String(spot.order), color: "#ffffff", fontSize: "11px", fontWeight: "700" },
          optimized: true
        });
        marker.addListener("mouseover", () => openSpotHoverCard(spot, marker, country));
        marker.addListener("mouseout", () => closeSpotHoverCard(marker));
        marker.addListener("click", () => {
          if (pinnedInfoSpot === spot) {
            activeInfoWindow.close();
            pinnedInfoSpot = null;
          } else {
            pinnedInfoSpot = spot;
            activeInfoWindow.setContent(mapInfoMarkup(spot, photoCache.get(photoCacheKey(spot, country)) || null));
            activeInfoWindow.open({ map: mapInstance, anchor: marker });
            refreshSpotPhoto(spot, country);
          }
          setRouteSelection(routeId, spot.order);
        });
        return { marker, spot, country };
      });
      if (focusOrder) {
        const focused = spots.find((spot) => Number(spot.order) === Number(focusOrder));
        if (focused) {
          mapInstance.panTo({ lat: focused.lat, lng: focused.lng });
          mapInstance.setZoom(15);
        }
      } else if (spots.length === 1) {
        mapInstance.setCenter(routePath[0]);
        mapInstance.setZoom(15);
      } else {
        const bounds = new google.maps.LatLngBounds();
        routePath.forEach((point) => bounds.extend(point));
        mapInstance.fitBounds(bounds, { top: 76, right: 76, bottom: 76, left: 76 });
        google.maps.event.addListenerOnce(mapInstance, "idle", () => {
          if (mapInstance.getZoom() > 16) mapInstance.setZoom(16);
        });
      }
    } else if (mapProvider === "leaflet") {
      const path = routePath.map((point) => [point.lat, point.lng]);
      routePolyline = L.polyline(path, {
        color: "#ff385c",
        weight: 4,
        opacity: .94,
        lineCap: "round",
        lineJoin: "round"
      }).addTo(mapInstance);
      routeMarkers = spots.map((spot) => {
        const icon = L.divIcon({
          className: "map-route-marker-wrap",
          html: `<span class="map-route-pin" data-map-route-pin="${escapeHTML(routeId)}" data-map-spot-order="${escapeHTML(spot.order)}"><span>${escapeHTML(spot.order)}</span></span>`,
          iconSize: [38, 38],
          iconAnchor: [19, 19]
        });
        const marker = L.marker([spot.lat, spot.lng], { icon, title: `${spot.order}. ${spot.name}`, keyboard: true }).addTo(mapInstance);
        marker.bindPopup(mapInfoMarkup(spot, photoCache.get(photoCacheKey(spot, country)) || null), { closeButton: true, maxWidth: 220, className: "spot-pinned-popup" });
        marker.on("mouseover", () => openSpotHoverCard(spot, marker, country));
        marker.on("mouseout", () => closeSpotHoverCard(marker));
        marker.on("click", () => {
          pinnedInfoSpot = pinnedInfoSpot === spot ? null : spot;
          setRouteSelection(routeId, spot.order);
          refreshSpotPhoto(spot, country);
        });
        return { marker, spot, country };
      });
      if (focusOrder) {
        focusRouteSpot(routeId, focusOrder);
      } else if (spots.length === 1) {
        mapInstance.flyTo(path[0], 15, { duration: .7 });
      } else {
        mapInstance.flyToBounds(routePolyline.getBounds(), { padding: [72, 72], maxZoom: 15, duration: 1, animate: true });
      }
    }
    setRouteSelection(routeId, focusOrder);
    pendingSpotOrder = null;
  }

  function selectRouteOnMap(routeId, spotOrder = null) {
    const route = routes.find((item) => item.id === routeId);
    if (!route) return;
    if (selectedCountryId !== route.countryId) {
      selectCountry(route.countryId, { toggle: false, openBoth: true, routeId, focusSpotOrder: spotOrder, scroll: false });
    } else if (selectedRouteId === routeId && spotOrder) {
      focusRouteSpot(routeId, spotOrder);
    } else {
      drawRouteOnMap(routeId, { focusOrder: spotOrder });
    }
    mapViewport.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  let overviewDots = [];
  let overviewLines = [];

  function addCountryMarkers() {
    // No country pins: show curated city waypoints as a subtle world-wide network instead.
    countryMarkers = [];
    clearOverviewNetwork();
    const seen = new Map();
    routes.forEach((route) => {
      (route.routeSpots || []).forEach((spot) => {
        const key = `${spot.lat.toFixed(2)},${spot.lng.toFixed(2)}`;
        if (!seen.has(key)) seen.set(key, { spot, countryId: route.countryId, routeId: route.id });
      });
    });
    const spots = [...seen.values()];

    if (mapProvider === "google") {
      spots.forEach(({ spot, countryId, routeId }) => {
        const dot = new google.maps.Marker({
          position: { lat: spot.lat, lng: spot.lng },
          map: mapInstance,
          title: `${spot.name} · 여행 루트 보기`,
          icon: {
            path: google.maps.SymbolPath.CIRCLE,
            scale: 5,
            fillColor: "#ff385c",
            fillOpacity: .85,
            strokeColor: "#ffffff",
            strokeWeight: 1.5
          },
          optimized: true
        });
        dot.addListener("click", () => selectCountry(countryId, { toggle: false, routeId }));
        overviewDots.push(dot);
      });
      routes.forEach((route) => {
        const path = (route.routeSpots || []).map((spot) => ({ lat: spot.lat, lng: spot.lng }));
        if (path.length < 2) return;
        overviewLines.push(new google.maps.Polyline({
          path,
          map: mapInstance,
          strokeColor: "#0075de",
          strokeOpacity: .28,
          strokeWeight: 2,
          icons: [{ icon: { path: "M 0,-1 0,1", strokeOpacity: 1, scale: 2 }, offset: "0", repeat: "12px" }],
          clickable: false
        }));
      });
      updateOverviewVisibility(mapInstance.getZoom());
      mapInstance.addListener("zoom_changed", () => updateOverviewVisibility(mapInstance.getZoom()));
    } else if (mapProvider === "leaflet") {
      spots.forEach(({ spot, countryId, routeId }) => {
        const icon = L.divIcon({
          className: "map-overview-dot-wrap",
          html: '<span class="map-overview-dot"></span>',
          iconSize: [12, 12],
          iconAnchor: [6, 6]
        });
        const marker = L.marker([spot.lat, spot.lng], { icon, title: `${spot.name} · 여행 루트 보기`, keyboard: true }).addTo(mapInstance);
        marker.on("click", () => selectCountry(countryId, { toggle: false, routeId }));
        overviewDots.push(marker);
      });
      routes.forEach((route) => {
        const path = (route.routeSpots || []).map((spot) => [spot.lat, spot.lng]);
        if (path.length < 2) return;
        overviewLines.push(L.polyline(path, {
          color: "#0075de",
          weight: 2,
          opacity: .3,
          dashArray: "4 8",
          interactive: false
        }).addTo(mapInstance));
      });
      const update = () => updateOverviewVisibility(mapInstance.getZoom());
      mapInstance.on("zoomend", update);
      update();
    }
  }

  function clearOverviewNetwork() {
    overviewDots.forEach((dot) => {
      if (mapProvider === "google") dot.setMap(null);
      else if (mapInstance) mapInstance.removeLayer(dot);
    });
    overviewLines.forEach((line) => {
      if (mapProvider === "google") line.setMap(null);
      else if (mapInstance) mapInstance.removeLayer(line);
    });
    overviewDots = [];
    overviewLines = [];
  }

  function updateOverviewVisibility(zoom) {
    const showDots = zoom >= 2 && !selectedCountryId;
    const showLines = zoom >= 5 && !selectedCountryId;
    if (mapProvider === "google") {
      overviewDots.forEach((dot) => dot.setVisible(showDots));
      overviewLines.forEach((line) => line.setVisible(showLines));
    } else if (mapProvider === "leaflet") {
      overviewDots.forEach((dot) => {
        if (showDots) { if (!mapInstance.hasLayer(dot)) dot.addTo(mapInstance); }
        else if (mapInstance.hasLayer(dot)) mapInstance.removeLayer(dot);
      });
      overviewLines.forEach((line) => {
        if (showLines) { if (!mapInstance.hasLayer(line)) line.addTo(mapInstance); }
        else if (mapInstance.hasLayer(line)) mapInstance.removeLayer(line);
      });
    }
  }

  function initGoogleMap() {
    if (mapInstance || !window.google?.maps) return;
    try {
      mapProvider = "google";
      mapInstance = new google.maps.Map(mapElement, {
        center: { lat: 18, lng: 10 },
        zoom: 2,
        minZoom: 2,
        maxZoom: 18,
        mapTypeControl: false,
        streetViewControl: false,
        fullscreenControl: false,
        clickableIcons: false
      });
      activeInfoWindow = new google.maps.InfoWindow();
      mapViewport.classList.add("has-map");
      mapFallbackMessage.hidden = true;
      mapStatus.textContent = "WORLD MAP · GOOGLE MAPS";
      mapCaption.textContent = "Google Maps";
      addCountryMarkers();
      if (pendingRouteId) drawRouteOnMap(pendingRouteId, { focusOrder: pendingSpotOrder });
    } catch (error) {
      mapInstance = null;
      initLeafletMap();
    }
  }

  function initLeafletMap() {
    if (mapInstance || !window.L || !mapElement) {
      if (!mapInstance) mapFallbackMessage.hidden = false;
      return;
    }
    mapProvider = "leaflet";
    mapInstance = L.map(mapElement, { zoomControl: false, scrollWheelZoom: false, worldCopyJump: true, minZoom: 2, maxZoom: 18 }).setView([18, 10], 2);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a>'
    }).addTo(mapInstance);
    L.control.zoom({ position: "bottomright" }).addTo(mapInstance);
    mapViewport.classList.add("has-map");
    mapFallbackMessage.hidden = true;
    mapStatus.textContent = "WORLD MAP · LEAFLET";
    mapCaption.textContent = "OpenStreetMap fallback";
    addCountryMarkers();
    if (pendingRouteId) drawRouteOnMap(pendingRouteId, { focusOrder: pendingSpotOrder });
  }

  function initializeMap() {
    const key = data.mapConfig?.googleMapsApiKey || window.JOURNEY_ARCHIVE_CONFIG?.googleMapsApiKey || "";
    if (!key) {
      initLeafletMap();
      return;
    }
    window.journeyArchiveMapReady = initGoogleMap;
    const script = document.createElement("script");
    script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}&callback=journeyArchiveMapReady&v=weekly`;
    script.async = true;
    script.defer = true;
    script.onerror = initLeafletMap;
    document.head.appendChild(script);
    window.setTimeout(() => { if (!mapInstance) initLeafletMap(); }, 9000);
  }

  function resetMapToWorld() {
    clearRouteLayers();
    pendingRouteId = null;
    pendingSpotOrder = null;
    if (!mapInstance) return;
    if (mapProvider === "google") {
      mapInstance.panTo({ lat: 18, lng: 10 });
      mapInstance.setZoom(2);
    } else {
      mapInstance.flyTo([18, 10], 2, { duration: .8 });
    }
  }

  function flagImageURL(country) {
    return `https://flagcdn.com/w40/${encodeURIComponent(country.countryCode.toLowerCase())}.png`;
  }

  function normalizeSearchTerm(value) {
    return String(value ?? "").toLocaleLowerCase().normalize("NFD").replace(/\p{M}/gu, "").replace(/[^\p{L}\p{N}]/gu, "");
  }

  function makeSearchIndex() {
    const countryAliases = {
      "united-kingdom": ["UK", "Britain", "Great Britain", "England"],
      "united-states": ["USA", "US", "U.S."],
      china: ["PRC", "중화인민공화국"],
      spain: ["España"]
    };
    const cityAliases = {
      spain: { Madrid: "마드리드", Barcelona: "바르셀로나" },
      portugal: { Lisbon: "리스본", Porto: "포르투" },
      china: { Beijing: "베이징", Shanghai: "상하이" },
      hungary: { Budapest: "부다페스트" },
      austria: { Vienna: "빈", Salzburg: "잘츠부르크" },
      finland: { Helsinki: "헬싱키", Rovaniemi: "로바니에미" },
      estonia: { Tallinn: "탈린" },
      germany: { Berlin: "베를린", Munich: "뮌헨" },
      "united-kingdom": { London: "런던", Edinburgh: "에든버러" },
      france: { Paris: "파리", Versailles: "베르사유", Lyon: "리옹" },
      cambodia: { "Phnom Penh": "프놈펜", "Siem Reap": "시엠립" },
      vietnam: { Hanoi: "하노이", "Ninh Bình": "닌빈", "Hội An": "호이안" },
      japan: { Tokyo: "도쿄", Kyoto: "교토" },
      italy: { Florence: "피렌체", Bologna: "볼로냐" },
      canada: { Toronto: "토론토", Vancouver: "밴쿠버" },
      "united-states": { "New York": "뉴욕", "San Francisco": "샌프란시스코" },
      mexico: { "Mexico City": "멕시코시티", Oaxaca: "오악사카" },
      peru: { Lima: "리마", Cusco: "쿠스코" },
      nepal: { Kathmandu: "카트만두", Pokhara: "포카라" },
      brazil: { "Rio de Janeiro": "리우데자네이루", "São Paulo": "상파울루" },
      chile: { Santiago: "산티아고", "San Pedro de Atacama": "산페드로 데 아타카마" },
      argentina: { "Buenos Aires": "부에노스아이레스", Iguazú: "이구아수" }
    };
    const index = [];

    countries.forEach((country) => {
      const aliases = countryAliases[country.id] || [];
      const travelTerms = [
        ...(country.travel?.food || []).flatMap((item) => [item.name, item.area]),
        ...(country.travel?.hotels || []).flatMap((item) => [item.name, item.area])
      ];
      index.push({
        kind: "country",
        countryId: country.id,
        label: country.localName,
        meta: `${country.name} · ${country.region} · ${country.count}개 큐레이션`,
        query: country.travel?.mapsQuery || country.name,
        zoom: country.zoom || 5,
        terms: [country.localName, country.name, country.region, ...aliases, ...travelTerms],
        exactTerms: [country.localName, country.name, ...aliases]
      });

      const cityIndex = new Map();
      routes.filter((route) => route.countryId === country.id).forEach((route) => {
        const city = route.location.split("·")[0].trim();
        const localizedCity = cityAliases[country.id]?.[city] || city;
        const key = normalizeSearchTerm(localizedCity);
        if (!cityIndex.has(key)) {
          cityIndex.set(key, {
          kind: "city",
          countryId: country.id,
          routeId: route.id,
          label: localizedCity,
            meta: `${country.localName} · ${route.title}`,
            query: `${city} ${country.name}`,
            zoom: 12,
            terms: [],
            exactTerms: [city, localizedCity]
          });
        }
        const candidate = cityIndex.get(key);
        candidate.terms.push(city, localizedCity, route.title, route.location, ...(route.stops || []));
      });
      index.push(...cityIndex.values());
    });
    return index;
  }

  function findSearchMatches(query) {
    const normalized = normalizeSearchTerm(query);
    if (!normalized) return [];
    return searchIndex.filter((candidate) => candidate.terms.some((term) => normalizeSearchTerm(term).includes(normalized)))
      .sort((a, b) => {
        const exactA = a.exactTerms.some((term) => normalizeSearchTerm(term) === normalized) ? 1 : 0;
        const exactB = b.exactTerms.some((term) => normalizeSearchTerm(term) === normalized) ? 1 : 0;
        if (exactA !== exactB) return exactB - exactA;
        if (a.kind !== b.kind) return a.kind === "country" ? -1 : 1;
        return a.label.localeCompare(b.label, "ko");
      });
  }

  function filterCountryCards(countryIds) {
    countryList.querySelectorAll("[data-country]").forEach((button) => {
      button.hidden = !countryIds.has(button.dataset.country);
      button.classList.remove("search-target");
    });
  }

  function hideSearchOptions() {
    searchResults.hidden = true;
    searchInput.setAttribute("aria-expanded", "false");
  }

  function showNoSearchResults() {
    searchResults.hidden = true;
    searchInput.setAttribute("aria-expanded", "false");
    searchFeedback.innerHTML = '<span aria-hidden="true">ⓘ</span><span>등록되지 않은 여행지입니다. 추후 업데이트 예정입니다.</span>';
    searchFeedback.hidden = false;
  }

  function chooseSearchResult(candidate) {
    lastActivatedSearch = normalizeSearchTerm(searchInput.value);
    searchFeedback.hidden = true;
    hideSearchOptions();
    filterCountryCards(new Set([candidate.countryId]));
    selectCountry(candidate.countryId, {
      toggle: false,
      openBoth: true,
      scroll: false,
      routeId: candidate.routeId || null,
      mapQuery: candidate.query,
      mapZoom: candidate.zoom,
      mapLabel: candidate.kind === "city" ? candidate.label : null
    });
    const card = countryList.querySelector(`[data-country="${candidate.countryId}"]`);
    if (card) {
      card.classList.add("search-target");
      card.focus({ preventScroll: true });
    }
    countryDetails.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function updateSearch() {
    const query = searchInput.value.trim();
    const normalized = normalizeSearchTerm(query);
    searchFeedback.hidden = true;
    if (!normalized) {
      currentSearchMatches = [];
      hideSearchOptions();
      filterCountryCards(new Set(countries.map((country) => country.id)));
      lastActivatedSearch = "";
      return;
    }

    if (selectedCountryId && normalized !== lastActivatedSearch) resetCountryView();
    currentSearchMatches = findSearchMatches(query);
    filterCountryCards(new Set(currentSearchMatches.map((candidate) => candidate.countryId)));

    if (!currentSearchMatches.length) {
      if ([...query].length >= 2) showNoSearchResults();
      else hideSearchOptions();
      return;
    }

    const exact = currentSearchMatches.find((candidate) => candidate.exactTerms.some((term) => normalizeSearchTerm(term) === normalized));
    if (exact && normalized.length >= 2 && normalized !== lastActivatedSearch) {
      chooseSearchResult(exact);
      return;
    }

    searchResults.innerHTML = currentSearchMatches.slice(0, 7).map((candidate, index) => `
      <button class="search-result" type="button" role="option" aria-selected="false" data-search-result="${index}">
        <span class="search-result-icon" aria-hidden="true">${candidate.kind === "city" ? "⌖" : escapeHTML(countryById.get(candidate.countryId)?.flag || "🌍")}</span>
        <span class="search-result-copy"><strong>${escapeHTML(candidate.label)}</strong><small>${escapeHTML(candidate.meta)}</small></span>
        <span class="search-result-arrow" aria-hidden="true">↗</span>
      </button>`).join("");
    searchResults.hidden = false;
    searchInput.setAttribute("aria-expanded", "true");
  }

  function submitSearch() {
    if (!searchInput.value.trim()) {
      hideSearchOptions();
      searchFeedback.hidden = true;
      return;
    }
    const matches = findSearchMatches(searchInput.value);
    if (!matches.length) {
      showNoSearchResults();
      return;
    }
    const normalized = normalizeSearchTerm(searchInput.value);
    const exact = matches.find((candidate) => candidate.exactTerms.some((term) => normalizeSearchTerm(term) === normalized));
    chooseSearchResult(exact || matches[0]);
  }

  function renderCountryCards() {
    countryList.innerHTML = countries.map((country, index) => `
      <button class="country-card" type="button" data-country="${escapeHTML(country.id)}" aria-pressed="false">
        <span class="country-card-top"><span class="country-index">${String(index + 1).padStart(2, "0")}</span></span>
        <span class="country-card-name"><img class="country-flag" src="${flagImageURL(country)}" alt="" width="24" height="18" loading="lazy">${escapeHTML(country.localName)}</span>
        <span class="country-card-region">${escapeHTML(country.region)} · ${String(country.count).padStart(2, "0")} NOTES${country.custom ? ' · MY ROUTE' : ""}</span>
        <span class="country-card-arrow" aria-hidden="true">↗</span>
      </button>`).join("");
    $("#country-count").textContent = `${countries.length} COUNTRIES`;
    $("#country-count-short").textContent = String(countries.length).padStart(2, "0");
  }

  function renderSafetyCards() {
    safetyCountryList.innerHTML = countries.map((country) => {
      const mainAlert = country.safetyAlerts?.[0];
      const backId = `safety-back-${country.id}`;
      return `
        <article class="safety-country-card" data-flip-card data-pinned="false">
          <div class="safety-card-inner">
            <button class="safety-card-face safety-card-front" type="button" data-flip-front aria-expanded="false" aria-controls="${backId}">
              <span class="safety-card-heading"><span class="safety-country-name"><img class="country-flag" src="${flagImageURL(country)}" alt="" width="24" height="18" loading="lazy"><strong>${escapeHTML(country.localName)}</strong></span><span class="risk-badge">${escapeHTML(mainAlert?.level || "정보")}</span></span>
              <span class="safety-card-topic">${escapeHTML(mainAlert?.title || "현지 안전정보")}</span>
              <span class="safety-flip-cue" aria-hidden="true">↻</span>
            </button>
            <div class="safety-card-face safety-card-back" id="${backId}" aria-hidden="true" inert>
              <div class="safety-card-heading"><span class="safety-country-name"><img class="country-flag" src="${flagImageURL(country)}" alt="" width="24" height="18" loading="lazy"><strong>${escapeHTML(country.localName)}</strong></span><span class="risk-badge">${escapeHTML(mainAlert?.level || "정보")}</span></div>
              <h4>${escapeHTML(mainAlert?.title || "현지 안전정보")}</h4>
              <p class="safety-country-summary">${escapeHTML(mainAlert?.detail || "여행 전 공식 안전 공지를 확인하세요.")}</p>
              ${mainAlert?.source?.url ? `<a class="safety-card-source" href="${safeURL(mainAlert.source.url)}" target="_blank" rel="noopener noreferrer">${escapeHTML(mainAlert.source.label)} ↗</a>` : ""}
              <div class="safety-card-actions">
                <button class="safety-flip-back" type="button" data-flip-back>앞면</button>
                <button class="safety-detail-link" type="button" data-safety-country="${escapeHTML(country.id)}">국가별 상세 ↗</button>
              </div>
            </div>
          </div>
        </article>`;
    }).join("");
  }

  function setSafetyCardFace(card, flipped, pinned = card.dataset.pinned === "true") {
    card.classList.toggle("is-flipped", flipped);
    card.dataset.pinned = String(pinned);
    const front = card.querySelector("[data-flip-front]");
    const back = card.querySelector(".safety-card-back");
    front.setAttribute("aria-expanded", String(flipped));
    front.setAttribute("aria-hidden", String(flipped));
    if (flipped) back.removeAttribute("inert");
    else back.setAttribute("inert", "");
    back.setAttribute("aria-hidden", String(!flipped));
  }

  function setSelectedCountryUI(country) {
    countryList.querySelectorAll("[data-country]").forEach((button) => {
      const active = button.dataset.country === country?.id;
      button.setAttribute("aria-pressed", String(active));
      button.classList.toggle("is-active", active);
    });
  }

  function resetCountryView() {
    countryDetails.hidden = true;
    selectedCountryId = null;
    setSelectedCountryUI(null);
    filterCountryCards(new Set(countries.map((country) => country.id)));
    resetMapToWorld();
    mapOpenLink.href = mapSearchURL("World map");
    mapStatus.textContent = "WORLD MAP";
    mapCaption.textContent = mapProvider === "google" ? "Google Maps" : "OpenStreetMap fallback";
  }

  function selectCountry(countryId, { toggle = true, openSafety = false, openBoth = true, scroll = true, mapQuery = null, mapZoom = null, mapLabel = null, routeId = null, focusSpotOrder = null } = {}) {
    const country = countryById.get(countryId);
    if (!country) return;

    if (toggle && selectedCountryId === countryId && !countryDetails.hidden) {
      resetCountryView();
      return;
    }

    selectedCountryId = countryId;
    setSelectedCountryUI(country);
    const countryRoutes = routes.filter((route) => route.countryId === countryId);
    const selectedRoute = countryRoutes.find((route) => route.id === routeId) || countryRoutes[0];
    const query = mapQuery || country.travel?.mapsQuery || country.name;
    const zoom = mapZoom || country.zoom || 5;
    mapOpenLink.href = selectedRoute ? googleDirectionsURL(selectedRoute) : mapSearchURL(query);
    mapStatus.textContent = selectedRoute
      ? `${country.name.toUpperCase()} · ROUTE ${selectedRoute.number}`
      : `${country.name.toUpperCase()} · ${country.region}`;
    mapCaption.textContent = mapLabel ? `${country.localName} · ${mapLabel}` : selectedRoute?.title || country.localName;
    renderCountryDetails(country, { openSafety, openBoth });
    countryDetails.hidden = false;
    if (selectedRoute) drawRouteOnMap(selectedRoute.id, { focusOrder: focusSpotOrder });
    else if (mapInstance) panToCountry(country, zoom);

    if (scroll) countryDetails.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function panToCountry(country, zoom = country.zoom || 5) {
    if (mapProvider === "google") {
      mapInstance.panTo({ lat: country.coordinates[0], lng: country.coordinates[1] });
      mapInstance.setZoom(zoom);
    } else if (mapProvider === "leaflet") {
      mapInstance.flyTo(country.coordinates, zoom, { duration: .8 });
    }
  }

  function selectRouteOnMap(routeId, spotOrder = null) {
    const route = routes.find((item) => item.id === routeId);
    if (!route) return;
    if (selectedCountryId !== route.countryId) {
      selectCountry(route.countryId, { toggle: false, openBoth: true, routeId, focusSpotOrder: spotOrder, scroll: false });
    } else if (selectedRouteId === routeId && spotOrder) {
      focusRouteSpot(routeId, spotOrder);
    } else {
      drawRouteOnMap(routeId, { focusOrder: spotOrder });
    }
    mapViewport.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function renderRouteCards(country) {
    const countryRoutes = country.routes || routes.filter((route) => route.countryId === country.id);
    if (!countryRoutes.length) return '<p class="empty-note">여행 루트가 준비 중입니다.</p>';
    return countryRoutes.map((route) => `
      <article class="mini-route-card" data-route-card="${escapeHTML(route.id)}">
        <div class="mini-route-image"><img src="${safeURL(route.image)}" alt="${escapeHTML(route.imageAlt)}" loading="lazy"><span>ROUTE ${escapeHTML(route.number)}</span></div>
        <div class="mini-route-copy">
          <div class="mini-route-meta"><span>${escapeHTML(route.location)}</span><span>${escapeHTML(route.duration)} · ${escapeHTML(route.distance)}</span></div>
          <h4>${escapeHTML(route.title)}</h4>
          <ol class="route-step-list" aria-label="${escapeHTML(route.title)} 경유 스팟">
            ${(route.routeSpots || []).map((spot) => `
              <li><button class="route-step" type="button" data-route-step="${escapeHTML(route.id)}" data-spot-order="${escapeHTML(spot.order)}" aria-label="${escapeHTML(spot.order)}번 ${escapeHTML(spot.name)} 지도에서 보기">
                <span class="route-step-number">${String(spot.order).padStart(2, "0")}</span><span class="route-step-name">${escapeHTML(spot.name)}</span><span class="route-step-arrow" aria-hidden="true">↗</span>
              </button></li>`).join("")}
          </ol>
          <button class="route-map-select" type="button" data-route-select="${escapeHTML(route.id)}">지도에서 루트 보기 <span aria-hidden="true">⌖</span></button>
          <a class="google-search-link" href="${googleDirectionsURL(route)}" target="_blank" rel="noopener noreferrer">Google 지도 경로 열기 <span aria-hidden="true">↗</span></a>
        </div>
      </article>`).join("");
  }

  function renderRecommendations(items, country, kind) {
    if (!items?.length) return '<p class="empty-note">추천 정보를 준비 중입니다.</p>';
    return `<div class="recommendation-list">${items.map((item) => `
      <details class="recommendation-disclosure">
        <summary>
          <span class="recommendation-summary-copy"><span class="recommendation-area">${escapeHTML(item.area)}</span><strong>${escapeHTML(item.name)}</strong></span>
          <span class="recommendation-chevron" aria-hidden="true">⌄</span>
        </summary>
        <div class="recommendation-detail">
          <p>${escapeHTML(item.detail)}</p>
          ${kind === "food" && item.mustTry ? `<p class="must-try"><strong>꼭 먹을 메뉴</strong><span>${escapeHTML(item.mustTry)}</span></p>` : ""}
          ${kind === "hotel" && item.nearbyTransit ? `<p class="nearby-transit"><strong>교통 거점</strong><span>${escapeHTML(item.nearbyTransit)}</span></p>` : ""}
          <a class="google-review-link" href="${mapSearchURL(item.mapsQuery || `${item.name} ${item.area} ${country.name}`)}" target="_blank" rel="noopener noreferrer">Google Maps에서 평점·${kind === "food" ? "메뉴·" : ""}후기 확인 <span aria-hidden="true">↗</span></a>
        </div>
      </details>`).join("")}</div>`;
  }

  function renderTravelPanel(country) {
    const travel = country.travel || {};
    return `
      <div class="panel-intro"><p class="panel-summary">${escapeHTML(travel.overview || "여행 루트와 현지 정보를 확인하세요.")}</p></div>
      <div class="travel-block">
        <div class="block-heading"><span class="block-sticker sticker-pink" aria-hidden="true">✈</span><div><p>CURATED ROUTES</p><h4>여행 루트</h4></div></div>
        <div class="mini-route-grid">${renderRouteCards(country)}</div>
      </div>
      <div class="travel-info-grid">
        <section class="travel-info-card">
          <div class="block-heading"><span class="block-sticker sticker-orange" aria-hidden="true">⌁</span><div><p>LOCAL TABLE</p><h4>로컬 맛집</h4></div></div>
          ${renderRecommendations(travel.food, country, "food")}
        </section>
        <section class="travel-info-card">
          <div class="block-heading"><span class="block-sticker sticker-purple" aria-hidden="true">⌂</span><div><p>PLACES TO STAY</p><h4>추천 숙소</h4></div></div>
          ${renderRecommendations(travel.hotels, country, "hotel")}
        </section>
      </div>
      <p class="review-method-note">${escapeHTML(data.recommendationNote || "Google 평점과 최근 후기는 지도 링크에서 확인하세요.")}</p>
      <div class="transit-callout"><span class="callout-icon" aria-hidden="true">🚆</span><div><strong>대중교통 팁</strong><p>${escapeHTML(countryRoutesText(country))}</p></div></div>
      <a class="country-map-link" href="${mapSearchURL(travel.mapsQuery || country.name)}" target="_blank" rel="noopener noreferrer">${escapeHTML(country.localName)} Google 지도 <span aria-hidden="true">↗</span></a>`;
  }

  function countryRoutesText(country) {
    const countryRoutes = routes.filter((route) => route.countryId === country.id);
    const tips = [...new Set(countryRoutes.map((route) => route.transit).filter(Boolean))];
    return tips.length ? tips.join(" ") : "현지 교통 수단과 운행 시간을 출발 전에 확인하세요.";
  }

  function renderSafetyPanel(country) {
    const alerts = country.safetyAlerts || [];
    const natural = country.naturalRisk || { level: "정보 확인", title: "자연재해 정보", detail: "공식 기상·재난 공지를 확인하세요." };
    return `
      <p class="advisory-note">여행경보와 현지 상황은 수시로 바뀝니다. 출발 전 공식 공지를 확인하세요.</p>
      <div class="alerts-list">${alerts.map((alert) => `
        <article class="safety-alert">
          <span class="alert-level">${escapeHTML(alert.level)}</span>
          <div class="safety-alert-copy"><h4>${escapeHTML(alert.title)}</h4><p>${escapeHTML(alert.detail)}</p><a href="${safeURL(alert.source?.url)}" target="_blank" rel="noopener noreferrer">${escapeHTML(alert.source?.label || "공식 안전 정보")} ↗</a></div>
        </article>`).join("")}</div>
      <article class="natural-risk-card">
        <div class="natural-risk-heading"><span class="block-sticker sticker-sky" aria-hidden="true">⌁</span><div><p>NATURAL HAZARDS</p><h4>${escapeHTML(natural.title)}</h4></div><span class="risk-badge">${escapeHTML(natural.level)}</span></div>
        <p>${escapeHTML(natural.detail)}</p>
        <div class="hazard-links"><a href="${safeURL(data.liveFeeds?.globalDisasterAlerts)}" target="_blank" rel="noopener noreferrer">GDACS 재난 경보 ↗</a><a href="${safeURL(data.liveFeeds?.tsunami)}" target="_blank" rel="noopener noreferrer">쓰나미 경보 ↗</a><a href="${safeURL(data.liveFeeds?.volcano)}" target="_blank" rel="noopener noreferrer">화산 활동 정보 ↗</a></div>
      </article>
      <aside class="profile-callout"><span aria-hidden="true">✳</span><div><strong>FIELD INSIGHT</strong><p>${escapeHTML(country.profileInsight || "공식 안내와 현장 상황을 함께 확인하세요.")}</p></div></aside>
      <a class="official-link country-official-link" href="https://www.0404.go.kr/" target="_blank" rel="noopener noreferrer">외교부에서 ${escapeHTML(country.localName)} 최신 여행경보 확인 ↗</a>`;
  }

  function accordionMarkup(country, type, title, icon, contents, isOpen) {
    const key = `${country.id}-${type}`;
    return `
      <article class="accordion-card${isOpen ? " is-open" : ""}" data-accordion="${key}">
        <button class="accordion-trigger" type="button" aria-expanded="${isOpen}" aria-controls="accordion-body-${key}" id="accordion-trigger-${key}">
          <span class="accordion-icon ${type === "travel" ? "accordion-icon-travel" : "accordion-icon-safety"}" aria-hidden="true">${icon}</span>
          <span class="accordion-title-wrap"><span class="accordion-overline">${type === "travel" ? "TRAVEL CURATION" : "SAFETY INTELLIGENCE"}</span><span class="accordion-title">${title}</span></span>
          <span class="accordion-chevron" aria-hidden="true">⌄</span>
        </button>
        <div class="accordion-content" id="accordion-body-${key}" role="region" aria-labelledby="accordion-trigger-${key}" aria-hidden="${!isOpen}"${isOpen ? "" : " inert"}>
          <div class="accordion-content-clip"><div class="accordion-inner">${contents}</div></div>
        </div>
      </article>`;
  }

  function renderCountryDetails(country, { openSafety = false, openBoth = false } = {}) {
    $("#selected-flag").src = flagImageURL(country);
    $("#selected-flag").alt = "";
    $("#selected-country-name").textContent = country.localName;
    $("#selected-country-overview").textContent = country.travel?.overview || "";
    const travelOpen = openBoth || !openSafety;
    const safetyOpen = openBoth || openSafety;
    accordionHost.innerHTML = `
      ${accordionMarkup(country, "travel", "여행 큐레이션", "✈", renderTravelPanel(country), travelOpen)}
      ${accordionMarkup(country, "safety", "안전 & 리스크 인텔리전스", "🛡", renderSafetyPanel(country), safetyOpen)}`;
  }

  function setupAccordions() {
    accordionHost.addEventListener("click", (event) => {
      const routeSelect = event.target.closest("[data-route-select]");
      if (routeSelect) {
        selectRouteOnMap(routeSelect.dataset.routeSelect);
        return;
      }
      const routeStep = event.target.closest("[data-route-step]");
      if (routeStep) {
        selectRouteOnMap(routeStep.dataset.routeStep, Number(routeStep.dataset.spotOrder));
        return;
      }
      const trigger = event.target.closest(".accordion-trigger");
      if (!trigger) return;
      const card = trigger.closest(".accordion-card");
      const body = card.querySelector(".accordion-content");
      const open = trigger.getAttribute("aria-expanded") !== "true";
      card.classList.toggle("is-open", open);
      trigger.setAttribute("aria-expanded", String(open));
      body.setAttribute("aria-hidden", String(!open));
      if (open) body.removeAttribute("inert");
      else body.setAttribute("inert", "");
    });
  }

  function setupSafetyCardInteractions() {
    safetyCountryList.addEventListener("pointerover", (event) => {
      if (event.pointerType !== "mouse") return;
      const card = event.target.closest("[data-flip-card]");
      if (!card || (event.relatedTarget && card.contains(event.relatedTarget)) || card.dataset.pinned === "true") return;
      setSafetyCardFace(card, true, false);
    });
    safetyCountryList.addEventListener("pointerout", (event) => {
      if (event.pointerType !== "mouse") return;
      const card = event.target.closest("[data-flip-card]");
      if (!card || (event.relatedTarget && card.contains(event.relatedTarget)) || card.dataset.pinned === "true") return;
      setSafetyCardFace(card, false, false);
    });
    safetyCountryList.addEventListener("click", (event) => {
      const countryLink = event.target.closest("[data-safety-country]");
      if (countryLink) {
        selectCountry(countryLink.dataset.safetyCountry, { toggle: false, openSafety: true, openBoth: false });
        return;
      }
      const card = event.target.closest("[data-flip-card]");
      if (!card) return;
      if (event.target.closest("[data-flip-back]")) {
        setSafetyCardFace(card, false, false);
        card.querySelector("[data-flip-front]").focus({ preventScroll: true });
      } else if (event.target.closest("[data-flip-front]")) {
        const pinned = card.dataset.pinned !== "true";
        setSafetyCardFace(card, pinned, pinned);
        if (pinned) card.querySelector("[data-flip-back]").focus({ preventScroll: true });
      }
    });
  }

  function setupNavigation() {
    // The header has no navigation tabs; anchor links in the page handle scrolling natively.
  }

  function setupBookIntro() {
    const intro = $("#book-intro");
    if (intro.hidden) return;
    const cover = $("#book-cover");
    const openButton = $("#book-open");
    let opening = false;
    let dismissed = false;

    const finishOpening = () => {
      if (dismissed) return;
      dismissed = true;
      intro.classList.add("is-dismissed");
      document.body.classList.remove("intro-locked");
      window.setTimeout(hideIntro, 650);
      if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
        hideIntro();
      }
    };

    const hideIntro = () => {
      if (intro.hidden) return;
      intro.hidden = true;
      intro.setAttribute("aria-hidden", "true");
      $("#hero-title").focus({ preventScroll: true });
    };

    const startOpening = () => {
      if (opening) return;
      opening = true;
      cover.setAttribute("aria-expanded", "true");
      openButton.setAttribute("aria-expanded", "true");
      intro.classList.add("is-opening");
      if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) finishOpening();
      else window.setTimeout(finishOpening, 1300);
    };

    cover.addEventListener("transitionend", (event) => {
      if (event.target === cover && event.propertyName === "transform") finishOpening();
    });
    intro.addEventListener("transitionend", (event) => {
      if (event.target !== intro || event.propertyName !== "opacity") return;
      hideIntro();
    });
    intro.addEventListener("click", startOpening);
    document.addEventListener("keydown", (event) => {
      if (intro.hidden) return;
      if (event.key === "Escape") {
        event.preventDefault();
        startOpening();
      } else if (event.key === "Tab") {
        const focusable = [cover, openButton].filter((element) => !element.disabled);
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    });
  }

  function setupSearch() {
    searchForm.addEventListener("submit", (event) => {
      event.preventDefault();
      submitSearch();
    });
    searchInput.addEventListener("input", updateSearch);
    searchInput.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        hideSearchOptions();
        searchFeedback.hidden = true;
      } else if (event.key === "ArrowDown" && !searchResults.hidden) {
        event.preventDefault();
        searchResults.querySelector(".search-result")?.focus();
      }
    });
    searchResults.addEventListener("click", (event) => {
      const option = event.target.closest("[data-search-result]");
      if (!option) return;
      const candidate = currentSearchMatches[Number(option.dataset.searchResult)];
      if (candidate) chooseSearchResult(candidate);
    });
    document.addEventListener("click", (event) => {
      if (!event.target.closest(".hero-search-wrap")) hideSearchOptions();
    });
  }

  const STORAGE_KEY = "journeyArchiveCustomDestinations";
  const modal = $("#destination-modal");
  const destinationForm = $("#destination-form");
  const spotRows = $("#spot-rows");
  const managedList = $("#managed-list");
  const toastElement = $("#toast");
  let customDestinations = loadCustomDestinations();
  let toastTimer = null;

  function loadCustomDestinations() {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed.filter((item) => item && item.id && item.countryCode) : [];
    } catch (error) {
      console.warn("Unable to read saved destinations.", error);
      return [];
    }
  }

  function saveCustomDestinations() {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(customDestinations));
    } catch (error) {
      console.warn("Unable to save destinations.", error);
      toast("저장 공간이 부족해 저장하지 못했습니다.");
    }
  }

  function rawImageURL(value) {
    return /^https:\/\//i.test(value || "") ? value : "";
  }

  function addCustomToData(item) {
    const id = item.id;
    const code = String(item.countryCode || "").toLowerCase();
    const localName = item.localName || item.name;
    const spots = (item.spots || []).map((spot, index) => ({
      order: index + 1,
      countryId: id,
      city: item.name,
      name: spot.name || `스팟 ${index + 1}`,
      lat: Number(spot.lat),
      lng: Number(spot.lng),
      desc: spot.desc || "",
      image: rawImageURL(spot.image),
      imageVerified: Boolean(rawImageURL(spot.image))
    })).filter((spot) => Number.isFinite(spot.lat) && Number.isFinite(spot.lng));
    if (!spots.length) return;

    const routeId = item.routeId || `custom-${id}`;
    const route = {
      id: routeId,
      countryId: id,
      number: String(routes.length + 1).padStart(2, "0"),
      title: `${localName} 여행 루트`,
      location: item.name,
      duration: "하루",
      distance: "—",
      coordinates: spots.map((spot) => [spot.lat, spot.lng]),
      stops: spots.map((spot) => spot.name),
      image: spots.find((spot) => spot.image)?.image || "",
      imageAlt: `${localName} 여행 사진`,
      note: item.overview || "직접 추가한 여행 루트입니다.",
      description: item.overview || "직접 추가한 여행 루트입니다.",
      highlights: spots.map((spot) => ({ name: spot.name, detail: spot.desc || "현지에서 만나는 여행 스팟입니다." })),
      food: item.foodMemo ? { name: item.foodMemo, detail: item.foodMemo } : undefined,
      swim: { name: "현지 안전 안내 확인", detail: "수영 가능 구역과 당일 안전 안내를 현지에서 확인하세요.", safety: "지정 수역만 이용" },
      transit: "현지 대중교통과 도로 상황을 출발 전에 확인하세요.",
      routeSpots: spots
    };

    const foodItems = item.foodMemo ? [{
      name: item.foodMemo,
      area: localName,
      detail: item.foodMemo,
      mustTry: item.foodMemo,
      mapsQuery: `${item.foodMemo} ${item.name}`
    }] : [];
    const hotelItems = item.hotelMemo ? [{
      name: item.hotelMemo,
      area: localName,
      detail: item.hotelMemo,
      nearbyTransit: "역·공항과의 접근성을 출발 전에 확인하세요.",
      mapsQuery: `${item.hotelMemo} ${item.name}`
    }] : [];

    const country = {
      id,
      name: item.name,
      localName,
      countryCode: code,
      flag: "🌍",
      region: item.region || "CUSTOM ROUTE",
      coordinates: [spots[0].lat, spots[0].lng],
      zoom: 12,
      count: 1,
      custom: true,
      travel: {
        overview: item.overview || "직접 추가한 여행지입니다.",
        food: foodItems,
        hotels: hotelItems,
        mapsQuery: item.name
      },
      safetyAlerts: item.safetyMemo ? [{
        level: "직접 추가",
        title: "내 안전·리스크 메모",
        detail: item.safetyMemo,
        source: { label: "외교부 해외안전여행", url: "https://www.0404.go.kr/" }
      }] : [{
        level: "정보 확인",
        title: "현지 안전 공지 확인",
        detail: "출발 전 여행경보와 현지 치안·기상 공지를 확인하세요.",
        source: { label: "외교부 해외안전여행", url: "https://www.0404.go.kr/" }
      }],
      naturalRisk: { level: "현지 확인", title: "지진·기상 등 자연재해", detail: "현지 재난 경보와 기상 안내를 출발 전에 확인하세요." },
      profileInsight: "직접 추가한 여행지는 현지 사정에 따라 달라질 수 있습니다. 공식 공지와 최신 후기를 함께 확인하세요.",
      routes: [route],
      routeSpots: spots
    };

    countries.push(country);
    routes.push(route);
    countryById.set(id, country);
  }

  function removeCustomFromData(id) {
    for (let index = routes.length - 1; index >= 0; index -= 1) {
      if (routes[index].countryId === id) routes.splice(index, 1);
    }
    for (let index = countries.length - 1; index >= 0; index -= 1) {
      if (countries[index].id === id) countries.splice(index, 1);
    }
    countryById.delete(id);
    if (selectedCountryId === id) resetCountryView();
  }

  function refreshAfterCustomChange() {
    searchIndex = makeSearchIndex();
    renderCountryCards();
    renderSafetyCards();
    if (mapInstance) addCountryMarkers();
  }

  function toast(message) {
    if (!toastElement) return;
    toastElement.textContent = message;
    toastElement.hidden = false;
    toastElement.classList.add("is-visible");
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => {
      toastElement.classList.remove("is-visible");
      window.setTimeout(() => { toastElement.hidden = true; }, 220);
    }, 2600);
  }

  function spotRowMarkup() {
    return `<div class="spot-row" data-spot-row>
      <input name="spotName" type="text" placeholder="장소명" required>
      <div class="spot-row-grid">
        <input name="spotLat" type="number" step="any" placeholder="위도 lat" required>
        <input name="spotLng" type="number" step="any" placeholder="경도 lng" required>
      </div>
      <input name="spotImage" type="url" placeholder="대표 사진 URL (https://...)">
      <input name="spotDesc" type="text" placeholder="한 줄 설명">
      <button type="button" class="spot-remove" aria-label="스팟 삭제">×</button>
    </div>`;
  }

  function addSpotRow() {
    spotRows.insertAdjacentHTML("beforeend", spotRowMarkup());
  }

  function renderManagedList() {
    if (!managedList) return;
    if (!customDestinations.length) {
      managedList.innerHTML = '<p class="managed-empty">아직 추가한 여행지가 없습니다.</p>';
      return;
    }
    managedList.innerHTML = customDestinations.map((item) => `
      <div class="managed-item">
        <span>${escapeHTML(item.localName || item.name)} <small>${escapeHTML(item.countryCode)}</small></span>
        <button type="button" class="managed-delete" data-delete-custom="${escapeHTML(item.id)}">삭제</button>
      </div>`).join("");
  }

  function openDestinationModal() {
    modal.hidden = false;
    document.body.classList.add("modal-open");
    renderManagedList();
    if (!spotRows.children.length) addSpotRow();
    destinationForm.querySelector('[name="countryName"]').focus();
  }

  function closeDestinationModal() {
    modal.hidden = true;
    document.body.classList.remove("modal-open");
  }

  function deleteCustomDestination(id) {
    const item = customDestinations.find((entry) => entry.id === id);
    if (!item) return;
    if (!window.confirm(`${item.localName || item.name} 여행지를 삭제할까요?`)) return;
    customDestinations = customDestinations.filter((entry) => entry.id !== id);
    saveCustomDestinations();
    removeCustomFromData(id);
    refreshAfterCustomChange();
    renderManagedList();
    toast("여행지를 삭제했습니다.");
  }

  function clearAllCustomDestinations() {
    if (!customDestinations.length) {
      toast("삭제할 여행지가 없습니다.");
      return;
    }
    if (!window.confirm("추가한 여행지를 모두 삭제할까요?")) return;
    customDestinations.slice().forEach((item) => removeCustomFromData(item.id));
    customDestinations = [];
    saveCustomDestinations();
    refreshAfterCustomChange();
    renderManagedList();
    toast("추가한 여행지를 모두 삭제했습니다.");
  }

  function handleDestinationSubmit(event) {
    event.preventDefault();
    const form = new FormData(destinationForm);
    const name = String(form.get("countryName") || "").trim();
    const code = String(form.get("countryCode") || "").trim().toLowerCase();
    if (!name || !/^[a-z]{2}$/.test(code)) {
      toast("국가명과 2자리 국가 코드를 확인해 주세요.");
      return;
    }
    const spots = [...spotRows.querySelectorAll("[data-spot-row]")].map((row) => ({
      name: String(row.querySelector('[name="spotName"]')?.value || "").trim(),
      lat: row.querySelector('[name="spotLat"]')?.value,
      lng: row.querySelector('[name="spotLng"]')?.value,
      image: String(row.querySelector('[name="spotImage"]')?.value || "").trim(),
      desc: String(row.querySelector('[name="spotDesc"]')?.value || "").trim()
    })).filter((spot) => spot.name && Number.isFinite(Number(spot.lat)) && Number.isFinite(Number(spot.lng)));
    if (!spots.length) {
      toast("위치가 있는 스팟을 하나 이상 추가해 주세요.");
      return;
    }

    const item = {
      id: `custom-${code}-${Date.now()}`,
      name,
      localName: name,
      countryCode: code,
      overview: String(form.get("overview") || "").trim(),
      foodMemo: String(form.get("foodMemo") || "").trim(),
      hotelMemo: String(form.get("hotelMemo") || "").trim(),
      safetyMemo: String(form.get("safetyMemo") || "").trim(),
      spots
    };
    customDestinations.push(item);
    saveCustomDestinations();
    addCustomToData(item);
    refreshAfterCustomChange();
    destinationForm.reset();
    spotRows.innerHTML = "";
    addSpotRow();
    closeDestinationModal();
    selectCountry(item.id, { toggle: false, openBoth: true, scroll: false });
    toast("새 여행지가 지도에 추가되었습니다!");
  }

  function copyText(text) {
    const fallback = () => {
      const area = document.createElement("textarea");
      area.value = text;
      area.setAttribute("readonly", "");
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.appendChild(area);
      area.select();
      let copied = false;
      try { copied = document.execCommand("copy"); } catch (error) { copied = false; }
      document.body.removeChild(area);
      return copied ? Promise.resolve() : Promise.reject(new Error("copy failed"));
    };
    if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text).catch(fallback);
    return fallback();
  }

  function shareSelectedDestination() {
    const country = countryById.get(selectedCountryId);
    if (!country) {
      toast("먼저 공유할 여행지를 선택해 주세요.");
      return;
    }
    const route = routes.find((entry) => entry.id === selectedRouteId && entry.countryId === country.id) || country.routes?.[0];
    const activeStep = countryDetails.querySelector(".route-step.is-active");
    const spotOrder = pinnedInfoSpot?.order || Number(activeStep?.dataset.spotOrder) || 1;
    const spot = route?.routeSpots?.find((entry) => entry.order === spotOrder);
    const url = new URL(window.location.href);
    url.searchParams.set("country", country.countryCode || country.id);
    url.searchParams.set("spot", String(spotOrder));
    if (route) url.searchParams.set("route", route.id);

    const title = `${country.localName} 여행 큐레이션 · Journey & Archive`;
    const text = [`${country.localName} · ${route?.title || "여행 루트"}`];
    if (spot) text.push(`${spot.order}. ${spot.name} — ${spot.desc || "여행 스팟"}`);
    if (route?.routeSpots?.length) text.push(`루트: ${route.routeSpots.map((entry) => entry.name).join(" → ")}`);
    text.push(url.toString());
    const summary = text.join("\n");

    if (navigator.share) {
      navigator.share({ title, text: summary, url: url.toString() }).catch(() => {});
      return;
    }
    copyText(summary).then(() => toast("공유 링크가 복사되었습니다!")).catch(() => toast("링크 복사에 실패했습니다."));
  }

  function applySharedURL() {
    const params = new URLSearchParams(window.location.search);
    const key = params.get("country");
    if (!key) return false;
    const normalized = key.toLowerCase();
    const country = countries.find((entry) => entry.id === key || String(entry.countryCode).toLowerCase() === normalized);
    if (!country) {
      toast("공유된 여행지를 찾을 수 없습니다.");
      return false;
    }
    const intro = $("#book-intro");
    if (intro) {
      intro.hidden = true;
      intro.setAttribute("aria-hidden", "true");
    }
    document.body.classList.remove("intro-locked");
    const routeId = params.get("route");
    const validRouteId = routeId && routes.some((entry) => entry.id === routeId && entry.countryId === country.id) ? routeId : undefined;
    selectCountry(country.id, {
      toggle: false,
      openBoth: true,
      routeId: validRouteId,
      focusSpotOrder: Number(params.get("spot")) || 1,
      scroll: false
    });
    window.setTimeout(() => mapViewport.scrollIntoView({ behavior: "smooth", block: "start" }), 400);
    toast("공유된 여행지를 열었습니다.");
    return true;
  }

  customDestinations.forEach((item) => addCustomToData(item));
  addSpotRow();
  renderManagedList();

  $("#add-destination").addEventListener("click", openDestinationModal);
  $("#close-destination-modal").addEventListener("click", closeDestinationModal);
  $("#reset-destinations").addEventListener("click", clearAllCustomDestinations);
  $("#clear-custom").addEventListener("click", clearAllCustomDestinations);
  $("#share-destination").addEventListener("click", shareSelectedDestination);
  $("#add-spot-row").addEventListener("click", addSpotRow);
  spotRows.addEventListener("click", (event) => {
    const remove = event.target.closest(".spot-remove");
    if (!remove) return;
    const row = remove.closest("[data-spot-row]");
    if (spotRows.children.length === 1) {
      row.querySelectorAll("input").forEach((input) => { input.value = ""; });
      return;
    }
    row.remove();
  });
  managedList.addEventListener("click", (event) => {
    const button = event.target.closest("[data-delete-custom]");
    if (button) deleteCustomDestination(button.dataset.deleteCustom);
  });
  destinationForm.addEventListener("submit", handleDestinationSubmit);
  modal.addEventListener("click", (event) => {
    if (event.target === modal) closeDestinationModal();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !modal.hidden) closeDestinationModal();
  });

  countryList.addEventListener("click", (event) => {
    const button = event.target.closest("[data-country]");
    if (button) selectCountry(button.dataset.country);
  });
  $("#close-country").addEventListener("click", resetCountryView);

  searchIndex = makeSearchIndex();
  renderCountryCards();
  renderSafetyCards();
  setupAccordions();
  setupSafetyCardInteractions();
  setupNavigation();
  setupSearch();
  applySharedURL();
  setupBookIntro();
  initializeMap();
})();
