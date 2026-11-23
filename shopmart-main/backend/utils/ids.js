export const isValidId = (value) => typeof value === "string" && value.trim().length >= 8 && value.trim().length <= 30;
