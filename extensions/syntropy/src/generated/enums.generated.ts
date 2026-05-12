// AUTO-GENERATED from shared/schemas/enums.json — DO NOT EDIT.
// Regenerate with `npm run codegen:openclaw-enums` in shared/schemas/.
//
// Consumed by openclaw's extensions/syntropy/src/tools.ts. The schema-drift
// CI workflow catches drift between enums.json and this file.

import { Type } from "@sinclair/typebox";

/** Meal type categories for food intake logging.. Values: breakfast, lunch, dinner, snack, supplement, beverage. */
export const MealTypeSchema = Type.Union(
  [
    Type.Literal("breakfast"),
    Type.Literal("lunch"),
    Type.Literal("dinner"),
    Type.Literal("snack"),
    Type.Literal("supplement"),
    Type.Literal("beverage"),
  ],
  { description: "MealTypeEnum — one of: breakfast, lunch, dinner, snack, supplement, beverage" },
);
