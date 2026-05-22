# Firestore Security Specification

## 1. Data Invariants

- **User Profiles (`/users/{userId}/`)**:
  - Each user has exactly one profile.
  - Profile must contain `name` and `email`.
  - Users can only read and write their own profile.
  - `email` is immutable once set (or must match auth email).

- **Transactions (`/users/{userId}/transactions/{transactionId}/`)**:
  - Belongs strictly to the user in the path.
  - Must have a valid `amount` (> 0).
  - `type` must be either 'income' or 'expense'.
  - `status` must be 'active' or 'deleted'.
  - `date` must be a valid string date.
  - `createdAt` is immutable.

- **Budgets (`/users/{userId}/budgets/{categoryId}/`)**:
  - Belongs strictly to the user in the path.
  - `amount` must be >= 0.
  - `categoryId` must be one of the predefined categories.
  - `updatedAt` should be current.

## 2. The "Dirty Dozen" Payloads (Red Team Test Cases)

1. **Identity Spoofing**: Attempt to create a transaction at `/users/USER_B/transactions/T1` while authenticated as `USER_A`.
2. **Resource Poisoning**: Create a transaction with a 1MB string as the `description`.
3. **ID Poisoning**: Create a budget with a document ID that is 16KB long.
4. **State Shortcutting**: Directly update a transaction status from 'active' to 'permanently_deleted' (if such state exists and is restricted).
5. **Type Poisoning**: Set `transaction.amount` to a Boolean `true`.
6. **Shadow Update**: Add an `isAdmin: true` field to the user profile.
7. **Bypassing Relation**: Create a transaction with a `userId` field (inside data) that doesn't match the path `userId`.
8. **Negative Budget**: Set a budget amount to `-500`.
9. **Unverified Write**: Attempt to write a transaction when `email_verified` is `false`.
10. **Immutable Edit**: Attempt to change the `createdAt` timestamp on an existing transaction.
11. **PII Leak**: Authenticated `USER_B` tries to `get` the profile of `USER_A`.
12. **System Field Hijack**: User attempts to modify `updatedAt` to a date in the future (manual override instead of `serverTimestamp()`).

## 3. Conflict Report & Mitigation

| Vulnerability | Mitigation Logic |
| :--- | :--- |
| Identity Spoofing | Path `userId` must match `request.auth.uid`. |
| Resource Poisoning | Strict `.size()` checks on all string fields. |
| Value Poisoning | `isValid[Entity]` helper with type and range checks. |
| Unverified Access | Mandate `request.auth.token.email_verified == true` for writes. |
| Shadow Updates | Use `affectedKeys().hasOnly([...])` in update blocks. |
| Identity Integrity | `incoming().ownerId == request.auth.uid` (if applicable). |
