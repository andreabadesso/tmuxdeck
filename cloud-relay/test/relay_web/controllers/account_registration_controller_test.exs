defmodule RelayWeb.AccountRegistrationControllerTest do
  use RelayWeb.ConnCase, async: true

  import Relay.AccountsFixtures

  describe "GET /accounts/register" do
    test "renders registration page", %{conn: conn} do
      conn = get(conn, ~p"/accounts/register")
      response = html_response(conn, 200)
      assert response =~ "Register"
      assert response =~ ~p"/accounts/log-in"
      assert response =~ ~p"/accounts/register"
    end

    test "redirects if already logged in", %{conn: conn} do
      conn = conn |> log_in_account(account_fixture()) |> get(~p"/accounts/register")

      assert redirected_to(conn) == ~p"/"
    end
  end

  describe "POST /accounts/register" do
    @tag :capture_log
    test "creates account but does not log in", %{conn: conn} do
      email = unique_account_email()

      conn =
        post(conn, ~p"/accounts/register", %{
          "account" => valid_account_attributes(email: email)
        })

      refute get_session(conn, :account_token)
      assert redirected_to(conn) == ~p"/accounts/log-in"

      assert conn.assigns.flash["info"] =~
               ~r/An email was sent to .*, please access it to confirm your account/
    end

    test "render errors for invalid data", %{conn: conn} do
      conn =
        post(conn, ~p"/accounts/register", %{
          "account" => %{"email" => "with spaces"}
        })

      response = html_response(conn, 200)
      assert response =~ "Register"
      assert response =~ "must have the @ sign and no spaces"
    end
  end
end
