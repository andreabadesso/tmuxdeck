defmodule RelayWeb.Router do
  use RelayWeb, :router

  import RelayWeb.AccountAuth

  pipeline :browser do
    plug :accepts, ["html"]
    plug :fetch_session
    plug :fetch_live_flash
    plug :put_root_layout, html: {RelayWeb.Layouts, :root}
    plug :protect_from_forgery
    plug :put_secure_browser_headers
    plug :fetch_current_scope_for_account
  end

  pipeline :api do
    plug :accepts, ["json"]
  end

  scope "/", RelayWeb do
    pipe_through :browser

    get "/", PageController, :home
  end

  # Enable LiveDashboard in development
  if Application.compile_env(:relay, :dev_routes) do
    import Phoenix.LiveDashboard.Router

    scope "/dev" do
      pipe_through :browser

      live_dashboard "/dashboard", metrics: RelayWeb.Telemetry
    end
  end

  ## Authentication routes

  scope "/", RelayWeb do
    pipe_through [:browser, :redirect_if_account_is_authenticated]

    get "/accounts/register", AccountRegistrationController, :new
    post "/accounts/register", AccountRegistrationController, :create
  end

  scope "/", RelayWeb do
    pipe_through [:browser, :require_authenticated_account]

    get "/accounts/settings", AccountSettingsController, :edit
    put "/accounts/settings", AccountSettingsController, :update
    get "/accounts/settings/confirm-email/:token", AccountSettingsController, :confirm_email

    live "/dashboard", DashboardLive
    live "/instances/new", InstanceNewLive
    live "/instances/:id", InstanceShowLive
  end

  scope "/", RelayWeb do
    pipe_through [:browser]

    get "/accounts/log-in", AccountSessionController, :new
    get "/accounts/log-in/:token", AccountSessionController, :confirm
    post "/accounts/log-in", AccountSessionController, :create
    delete "/accounts/log-out", AccountSessionController, :delete
  end
end
