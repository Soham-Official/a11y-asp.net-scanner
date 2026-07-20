using System;
using System.Web.UI;
using System.Web.UI.WebControls;

public partial class _Default : Page
{
  protected void Page_Load(object sender, EventArgs e)
  {
    // Intentional violations for code-behind heuristics
    var hero = new Image { ImageUrl = "~/img/hero.png" };
    var cta = new Button { ID = "BtnPrimary" };
    var nav = new HyperLink { NavigateUrl = "~/reports" };
    var input = new TextBox { ID = "TxtSearch" };
    var deferredLogo = new Image { ImageUrl = "~/img/deferred.png" };
    deferredLogo.AlternateText = "Deferred logo";
    var deferredInput = new TextBox { ID = "TxtDeferred" };
    deferredInput.Attributes["aria-label"] = "Deferred search";

    // Clean pattern should not fire for Image
    var logo = new Image { ImageUrl = "~/img/logo.png", AlternateText = "Company logo" };

    this.ClientScript.RegisterClientScriptInclude(
      this.GetType(),
      "jquery",
      "https://cdn.example.com/jquery.min.js"
    );

    this.Response.AppendHeader("Refresh", "5;url=/timeout");

    this.Controls.Add(hero);
    this.Controls.Add(cta);
    this.Controls.Add(nav);
    this.Controls.Add(input);
    this.Controls.Add(deferredLogo);
    this.Controls.Add(deferredInput);
    this.Controls.Add(logo);
  }
}
