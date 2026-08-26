import { createBrowserRouter } from "react-router";
import { Layout } from "./app/Layout.js";
import {
  BandDetailView,
  BandsView,
  CraftDetailView,
  ItemDetailView,
  ItemsView,
  NotFoundView,
  ScanView,
} from "./views/index.js";

/**
 * Routes.
 *
 * Bands are at `/` rather than `/bands` because they are what someone opens before
 * setting up orders for the evening — the ranked craft scan is the secondary view, not the
 * front door.
 *
 * Deep links work in production because `wrangler.jsonc` sets
 * `not_found_handling: "single-page-application"`, so `/bands/COAL` serves index.html and
 * the router takes it from there.
 */
export const router = createBrowserRouter([
  {
    path: "/",
    element: <Layout />,
    children: [
      { index: true, element: <BandsView /> },
      { path: "bands/:tag", element: <BandDetailView /> },
      { path: "scan", element: <ScanView /> },
      { path: "craft/:baseTag", element: <CraftDetailView /> },
      { path: "items", element: <ItemsView /> },
      { path: "item/:tag", element: <ItemDetailView /> },
      { path: "*", element: <NotFoundView /> },
    ],
  },
]);
