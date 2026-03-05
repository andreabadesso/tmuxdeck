defmodule RelayWeb.AccountSessionController do
  use RelayWeb, :controller

  alias Relay.Accounts
  alias RelayWeb.AccountAuth

  def new(conn, _params) do
    email = get_in(conn.assigns, [:current_scope, Access.key(:account), Access.key(:email)])
    form = Phoenix.Component.to_form(%{"email" => email}, as: "account")

    render(conn, :new, form: form)
  end

  # magic link login
  def create(conn, %{"account" => %{"token" => token} = account_params} = params) do
    info =
      case params do
        %{"_action" => "confirmed"} -> "Account confirmed successfully."
        _ -> "Welcome back!"
      end

    case Accounts.login_account_by_magic_link(token) do
      {:ok, {account, _expired_tokens}} ->
        conn
        |> put_flash(:info, info)
        |> AccountAuth.log_in_account(account, account_params)

      {:error, :not_found} ->
        conn
        |> put_flash(:error, "The link is invalid or it has expired.")
        |> render(:new, form: Phoenix.Component.to_form(%{}, as: "account"))
    end
  end

  # email + password login
  def create(conn, %{"account" => %{"email" => email, "password" => password} = account_params}) do
    if account = Accounts.get_account_by_email_and_password(email, password) do
      conn
      |> put_flash(:info, "Welcome back!")
      |> AccountAuth.log_in_account(account, account_params)
    else
      form = Phoenix.Component.to_form(account_params, as: "account")

      # In order to prevent user enumeration attacks, don't disclose whether the email is registered.
      conn
      |> put_flash(:error, "Invalid email or password")
      |> render(:new, form: form)
    end
  end

  # magic link request
  def create(conn, %{"account" => %{"email" => email}}) do
    if account = Accounts.get_account_by_email(email) do
      Accounts.deliver_login_instructions(
        account,
        &url(~p"/accounts/log-in/#{&1}")
      )
    end

    info =
      "If your email is in our system, you will receive instructions for logging in shortly."

    conn
    |> put_flash(:info, info)
    |> redirect(to: ~p"/accounts/log-in")
  end

  def confirm(conn, %{"token" => token}) do
    if account = Accounts.get_account_by_magic_link_token(token) do
      form = Phoenix.Component.to_form(%{"token" => token}, as: "account")

      conn
      |> assign(:account, account)
      |> assign(:form, form)
      |> render(:confirm)
    else
      conn
      |> put_flash(:error, "Magic link is invalid or it has expired.")
      |> redirect(to: ~p"/accounts/log-in")
    end
  end

  def delete(conn, _params) do
    conn
    |> put_flash(:info, "Logged out successfully.")
    |> AccountAuth.log_out_account()
  end
end
