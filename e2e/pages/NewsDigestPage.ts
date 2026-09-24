import { expect, type Locator, type Page } from "@playwright/test";
import { AUTH_TOKEN_KEY } from "../support/env";

export type AuthMode = "login" | "signup";

export class TopicCard {
  constructor(readonly root: Locator) {}

  get heading(): Locator {
    return this.root.getByRole("heading", { level: 2 });
  }
  get keywords(): Locator {
    return this.root.locator(".keywords");
  }
  get recap(): Locator {
    return this.root.locator(".recap");
  }
  get articles(): Locator {
    return this.root.locator("ul.articles > li");
  }
  get staleNote(): Locator {
    return this.root.locator(".stale-note");
  }
  get emptyNote(): Locator {
    return this.root.locator("p.empty");
  }
  get topStoryBadge(): Locator {
    return this.root.locator(".top-story");
  }
  get meters(): Locator {
    return this.root.getByRole("button", { name: /^Match strength/ });
  }
  get editButton(): Locator {
    return this.root.getByRole("button", { name: "Edit", exact: true });
  }
  get deleteButton(): Locator {
    return this.root.getByRole("button", { name: /^(Delete|Confirm delete)$/ });
  }
  get cancelDeleteButton(): Locator {
    return this.root.getByRole("button", { name: "Cancel", exact: true });
  }
  get showMoreButton(): Locator {
    return this.root.locator("button.show-more");
  }
  // Edit mode replaces the heading with inputs, so these are only present
  // while editing.
  get editNameInput(): Locator {
    return this.root.locator(".edit-form").getByPlaceholder("Topic name");
  }
  get editKeywordsInput(): Locator {
    return this.root.locator(".edit-form").getByPlaceholder("Keywords, comma separated");
  }
  get saveEditButton(): Locator {
    return this.root.locator(".edit-form").getByRole("button", { name: "Save", exact: true });
  }
  get cancelEditButton(): Locator {
    return this.root.locator(".edit-form").getByRole("button", { name: "Cancel", exact: true });
  }
}

// Everything the specs need to know about the page's structure lives here,
// so a markup change means editing one file, not forty assertions.
export class NewsDigestPage {
  readonly authRow: Locator;
  readonly demoBanner: Locator;
  readonly emailInput: Locator;
  readonly passwordInput: Locator;
  readonly authError: Locator;
  readonly signedInEmail: Locator;
  readonly logOutButton: Locator;
  readonly digestSettingsButton: Locator;
  readonly refreshButton: Locator;
  readonly fetchStatus: Locator;
  readonly pageError: Locator;
  readonly emptyAccountMessage: Locator;
  readonly addTopicSection: Locator;
  readonly newTopicName: Locator;
  readonly newTopicKeywords: Locator;
  readonly addTopicButton: Locator;
  readonly addTopicError: Locator;
  readonly topicSections: Locator;
  readonly datePills: Locator;
  readonly digestForm: Locator;
  readonly tickersPanel: Locator;
  readonly tickerRows: Locator;

  constructor(readonly page: Page) {
    this.authRow = page.locator(".auth-row");
    this.demoBanner = page.getByText("You're viewing a demo.");
    this.emailInput = this.authRow.getByPlaceholder("Email");
    this.passwordInput = this.authRow.getByPlaceholder("Password");
    this.authError = page.locator(".auth-error");
    this.signedInEmail = this.authRow.locator(".auth-status");
    this.logOutButton = page.getByRole("button", { name: "Log out" });
    this.digestSettingsButton = page.getByRole("button", { name: "Digest settings" });
    this.refreshButton = page.getByRole("button", { name: /^(Refresh my feed|Fetching…)$/ });
    this.fetchStatus = page.locator(".fetch-status");
    this.pageError = page.locator(".page-error");
    this.emptyAccountMessage = page.getByText("You don't have any topics yet");
    this.addTopicSection = page.locator("section.add-topic");
    this.newTopicName = this.addTopicSection.getByPlaceholder("Topic name");
    this.newTopicKeywords = this.addTopicSection.getByPlaceholder("Keywords, comma separated (optional)");
    this.addTopicButton = this.addTopicSection.getByRole("button", { name: /^(Add topic|Adding…)$/ });
    this.addTopicError = this.addTopicSection.locator("p.error");
    this.topicSections = page.locator("section.topic");
    this.datePills = page.locator(".date-picker button");
    this.digestForm = page.locator("form.digest-settings");
    this.tickersPanel = page.locator("aside.tickers-panel");
    this.tickerRows = page.locator(".ticker-row");
  }

  async goto(path = "/"): Promise<void> {
    await this.page.goto(path);
  }

  // Skips the login form by planting a valid session token before the app
  // boots — the app then restores it via GET /api/me, the same path a
  // returning visitor takes. The form itself is covered once, in auth.spec.
  async gotoAs(user: { token: string }): Promise<void> {
    await this.page.addInitScript(
      ([key, token]) => window.localStorage.setItem(key, token),
      [AUTH_TOKEN_KEY, user.token]
    );
    await this.page.goto("/");
    await expect(this.logOutButton).toBeVisible();
  }

  async openAuthForm(mode: AuthMode): Promise<void> {
    await this.authRow.getByRole("button", { name: mode === "signup" ? "Sign up" : "Log in", exact: true }).click();
    await expect(this.emailInput).toBeVisible();
  }

  async submitAuth(mode: AuthMode, email: string, password: string): Promise<void> {
    await this.emailInput.fill(email);
    await this.passwordInput.fill(password);
    await this.authRow
      .getByRole("button", { name: mode === "signup" ? "Sign up" : "Log in", exact: true })
      .click();
  }

  async signUp(email: string, password: string): Promise<void> {
    await this.openAuthForm("signup");
    await this.submitAuth("signup", email, password);
    await expect(this.logOutButton).toBeVisible();
  }

  async logIn(email: string, password: string): Promise<void> {
    await this.openAuthForm("login");
    await this.submitAuth("login", email, password);
    await expect(this.logOutButton).toBeVisible();
  }

  async logOut(): Promise<void> {
    await this.logOutButton.click();
    await expect(this.demoBanner).toBeVisible();
  }

  async storedToken(): Promise<string | null> {
    return this.page.evaluate((key) => window.localStorage.getItem(key), AUTH_TOKEN_KEY);
  }

  async addTopic(name: string, keywords = ""): Promise<void> {
    await this.newTopicName.fill(name);
    await this.newTopicKeywords.fill(keywords);
    await this.addTopicButton.click();
  }

  topic(name: string): TopicCard {
    return new TopicCard(
      this.topicSections.filter({ has: this.page.getByRole("heading", { level: 2, name, exact: true }) })
    );
  }

  topicAt(index: number): TopicCard {
    return new TopicCard(this.topicSections.nth(index));
  }

  async openDigestSettings(): Promise<void> {
    await this.digestSettingsButton.click();
    await expect(this.digestForm).toBeVisible();
  }

  get digestTime(): Locator {
    return this.digestForm.locator('input[type="time"]');
  }
  get digestTimezone(): Locator {
    return this.digestForm.locator("select");
  }
  get digestEnabled(): Locator {
    return this.digestForm.getByRole("checkbox", { name: "Email me a daily digest" });
  }
  get digestSave(): Locator {
    return this.digestForm.getByRole("button", { name: /^(Save|Saving…)$/ });
  }
  get digestError(): Locator {
    return this.digestForm.locator("p.error");
  }

  get tickerInput(): Locator {
    return this.tickersPanel.getByPlaceholder("Symbol, e.g. AAPL");
  }
  get tickerAddButton(): Locator {
    return this.tickersPanel.getByRole("button", { name: /^(Add|Adding…)$/ });
  }
  get tickerError(): Locator {
    return this.tickersPanel.locator("p.error");
  }
}
