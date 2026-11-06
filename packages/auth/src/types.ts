export type RestaurantRole = "STAFF" | "MANAGER" | "SYSTEM_ADMIN";

export type Membership = {
  restaurantId: string;
  restaurantName: string;
  role: RestaurantRole;
};

export type AuthenticatedUser = {
  userId: string;
  displayName: string;
  memberships: Membership[];
};

export type AuthorizedContext = {
  sessionId: string;
  userId: string;
  displayName: string;
  restaurantId: string;
  role: RestaurantRole;
  mfaVerified: boolean;
};
